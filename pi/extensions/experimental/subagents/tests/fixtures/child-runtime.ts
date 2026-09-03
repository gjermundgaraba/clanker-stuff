import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { PermanentChildError } from "../../permanent-error.js";
import type { ChildRuntime, ChildTurnOutcome, PromptInput, RuntimeMessage } from "../../runtime.js";

interface VoidDeferred {
  promise: Promise<void>;
  reject: (cause?: unknown) => void;
  resolve: () => void;
}

const createVoidDeferred = (): VoidDeferred => {
  const deferred = Promise.withResolvers<undefined>();
  return {
    promise: deferred.promise,
    reject: deferred.reject,
    resolve: () => {
      deferred.resolve(undefined);
    },
  };
};

export interface FakeTurn {
  accepted: VoidDeferred;
  input: PromptInput;
  settled: PromiseWithResolvers<ChildTurnOutcome>;
}

export class FakeChildRuntime implements ChildRuntime {
  readonly calls: RuntimeMessage[] = [];
  readonly commit = vi.fn<ChildRuntime["commit"]>();
  readonly dispose = vi.fn<ChildRuntime["dispose"]>(async () => {
    const failure = new PermanentChildError("Child runtime was disposed");
    for (const turn of this.turns) {
      turn.accepted.reject(failure);
    }
    for (const acceptance of this.messageAcceptances) {
      acceptance.reject(failure);
    }
    await this.abort();
  });
  readonly rollback = vi.fn<ChildRuntime["rollback"]>(async () => {
    await this.dispose();
  });
  readonly messageAcceptances: VoidDeferred[] = [];
  readonly sessionFile: string;
  readonly turns: FakeTurn[] = [];
  acceptMessages = true;
  acceptTurns = true;
  beforeSendMessage?: () => void;
  failPersistence = false;
  streaming = false;

  constructor(identity: string) {
    this.sessionFile = `/tmp/subagent-test/sessions/${identity.replaceAll("/", "-")}.jsonl`;
  }

  async abort(): Promise<void> {
    this.streaming = false;
    this.turns.at(-1)?.settled.resolve({ status: "interrupted" });
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  sendMessage(message: RuntimeMessage, onEnqueued?: () => void, triggerTurn = false) {
    this.calls.push(message);
    this.beforeSendMessage?.();
    if (triggerTurn && !this.streaming) {
      return this.startTurn({ text: message.content });
    }
    const accepted = createVoidDeferred();
    this.messageAcceptances.push(accepted);
    if (this.failPersistence) {
      accepted.reject(new PermanentChildError("append failed"));
    } else if (this.acceptMessages) {
      onEnqueued?.();
      accepted.resolve();
    }
    return { accepted: accepted.promise };
  }

  startTurn(input: PromptInput) {
    const turn: FakeTurn = {
      accepted: createVoidDeferred(),
      input,
      settled: Promise.withResolvers(),
    };
    this.turns.push(turn);
    this.streaming = true;
    if (this.failPersistence) {
      turn.accepted.reject(new PermanentChildError("append failed"));
    } else if (this.acceptTurns) {
      turn.accepted.resolve();
    }
    void (async () => {
      try {
        await turn.settled.promise;
      } catch {
        // The controller observes the same rejection through the public turn.
      } finally {
        this.streaming = false;
      }
    })();
    return {
      accepted: turn.accepted.promise,
      settled: turn.settled.promise,
    };
  }
}

export const createChildContext = (): ExtensionContext =>
  createExtensionHost(() => {}).createContext();
