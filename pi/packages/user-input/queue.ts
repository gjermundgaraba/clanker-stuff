import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const queueKey = Symbol.for("@clanker-stuff/pi-user-input/queue");
// Pi loads each extension in a separate Jiti module scope, but shares globalThis.
// SAFETY: This namespaced symbol is owned solely by this module across those scopes.
const host = globalThis as typeof globalThis & {
  [queueKey]?: WeakMap<object, Promise<void>>;
};
const queues = (host[queueKey] ??= new WeakMap<object, Promise<void>>());

/** Serialize prompts on a Pi UI surface. Running callbacks must settle on abort. */
export async function runQueuedPrompt<T>(
  ctx: Pick<ExtensionContext, "ui">,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const ui = ctx.ui;
  const previous = queues.get(ui) ?? Promise.resolve();
  const released = Promise.withResolvers<void>();
  const tail = previous.then(() => released.promise);
  queues.set(ui, tail);
  const controller = new AbortController();
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    controller.abort(signal?.reason);
    aborted.reject(controller.signal.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([previous, aborted.promise]);
    controller.signal.throwIfAborted();
    return await run(controller.signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    released.resolve();
    void tail.then(() => {
      if (queues.get(ui) === tail) queues.delete(ui);
    });
  }
}
