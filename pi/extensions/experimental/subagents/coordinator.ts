import { createMemoryControlStore, serializeSnapshot } from "./snapshot.js";
import type { ControlStore, RootBinding, SubagentsSnapshot } from "./snapshot.js";

type Listener = (state: SubagentsSnapshot) => void;

const freeze = <T>(value: T): T => {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(Object(value))) {
      freeze(child);
    }
  }
  return value;
};

const placeholderRoot: RootBinding = {
  sessionFile: null,
  sessionId: "uninitialized",
};

export class TreeCoordinator {
  #error: Error | undefined;
  readonly #listeners = new Set<Listener>();
  #state: SubagentsSnapshot = freeze({
    nicknames: [],
    protocolLatch: "off",
    revision: 0,
    root: placeholderRoot,
    version: 1,
  });
  #store: ControlStore = createMemoryControlStore();
  #tail: Promise<void> = Promise.resolve();

  get error(): Error | undefined {
    return this.#error;
  }

  get state(): Readonly<SubagentsSnapshot> {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async install(store: ControlStore, state: SubagentsSnapshot, persist: boolean): Promise<void> {
    await this.#enqueue(async () => {
      this.#store = store;
      this.#error = undefined;
      const next = freeze(structuredClone(state));
      if (!persist) {
        this.#state = next;
        this.#emit();
        return;
      }
      await this.#write(next, false);
    });
  }

  async installProvisional(
    store: ControlStore,
    state: SubagentsSnapshot,
    activate: () => void,
  ): Promise<void> {
    await this.#enqueue(() => {
      this.#store = store;
      this.#error = undefined;
      const next = freeze(structuredClone(state));
      activate();
      this.#state = next;
      this.#emit();
      return Promise.resolve();
    });
  }

  async transact<T>(
    mutate: (draft: SubagentsSnapshot) => T,
    options: {
      onCommit?: () => void;
      reserveTerminalHeadroom?: boolean;
    } = {},
  ): Promise<T> {
    let result!: T;
    await this.#enqueue(async () => {
      this.#assertHealthy();
      const draft = structuredClone(this.#state);
      result = mutate(draft);
      draft.revision += 1;
      await this.#write(freeze(draft), options.reserveTerminalHeadroom ?? false, options.onCommit);
    });
    return result;
  }

  async command<T>(command: () => T): Promise<T> {
    let result!: T;
    await this.#enqueue(() => {
      this.#assertHealthy();
      result = command();
      return Promise.resolve();
    });
    return result;
  }

  async barrier(): Promise<void> {
    await this.#tail;
  }

  #assertHealthy(): void {
    if (this.#error !== undefined) {
      throw this.#error;
    }
  }

  async #write(
    next: SubagentsSnapshot,
    reserveTerminalHeadroom: boolean,
    onCommit?: () => void,
  ): Promise<void> {
    const serialized = serializeSnapshot(next, reserveTerminalHeadroom);
    try {
      const durabilityError = await this.#store.write(serialized, () => {
        this.#state = next;
        onCommit?.();
      });
      if (durabilityError !== undefined) {
        this.#error = durabilityError;
      }
      this.#emit();
    } catch (error) {
      this.#error = error instanceof Error ? error : new Error(String(error));
      throw this.#error;
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.#tail;
    const current = (async () => {
      await previous;
      await operation();
    })();
    this.#tail = (async () => {
      try {
        await current;
      } catch {
        // A failed operation must not break serialization for the next install.
      }
    })();
    await current;
  }
}
