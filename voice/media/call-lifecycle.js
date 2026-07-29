/* eslint-disable promise/avoid-new, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, promise/prefer-catch, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/prefer-nullish-coalescing, typescript/prefer-promise-reject-errors, typescript/strict-boolean-expressions */

export class CallLifecycle {
  #attempt;
  #nextAttemptId = 0;
  #state = "closed";

  constructor(startupTimeoutMs) {
    if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
      throw new Error("startupTimeoutMs must be positive.");
    }
    this.startupTimeoutMs = startupTimeoutMs;
  }

  get state() {
    return this.#state;
  }

  beginStart() {
    this.#transition("start");
    const controller = new AbortController();
    this.#nextAttemptId += 1;
    const attempt = {
      controller,
      id: this.#nextAttemptId,
      signal: controller.signal,
      timeout: setTimeout(() => {
        if (
          !this.isCurrent(attempt) ||
          attempt.signal.aborted ||
          this.#state === "active"
        ) {
          return;
        }
        controller.abort(new Error("Voice call startup timed out."));
      }, this.startupTimeoutMs),
    };
    this.#attempt = attempt;
    return attempt;
  }

  markNegotiating(attempt) {
    if (!this.isCurrent(attempt)) {
      return false;
    }
    this.#transition("media-ready");
    return true;
  }

  markActive(attempt) {
    if (!this.isCurrent(attempt)) {
      return false;
    }
    this.#transition("connected");
    this.#clearTimeout();
    return true;
  }

  beginStop(reason) {
    if (
      this.#state === "closed" ||
      this.#state === "stopping" ||
      this.#state === "failed"
    ) {
      return false;
    }
    this.#transition("stop");
    this.#attempt?.controller.abort(new Error(reason || "Voice call stopped."));
    this.#clearTimeout();
    return true;
  }

  fail(attempt, error) {
    if (
      !this.isCurrent(attempt) ||
      this.#state === "stopping" ||
      this.#state === "closed"
    ) {
      return false;
    }
    this.#transition("fail");
    this.#attempt?.controller.abort(error);
    this.#clearTimeout();
    return true;
  }

  finishClose() {
    if (this.#state === "closed") {
      return;
    }
    this.#transition("closed");
    this.#clearTimeout();
    this.#attempt = undefined;
  }

  isCurrent(attempt) {
    return this.#attempt?.id === attempt.id;
  }

  wait(attempt, operation, disposeLateValue) {
    if (!this.isCurrent(attempt)) {
      return Promise.reject(new Error("Stale voice call attempt."));
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      const rejectForAbort = () => {
        if (finished) {
          return;
        }
        finished = true;
        reject(
          attempt.signal.reason instanceof Error
            ? attempt.signal.reason
            : new Error("Voice call stopped.")
        );
      };
      attempt.signal.addEventListener("abort", rejectForAbort, { once: true });
      operation.then(
        (value) => {
          if (finished || !this.isCurrent(attempt) || attempt.signal.aborted) {
            disposeLateValue?.(value);
            return;
          }
          finished = true;
          attempt.signal.removeEventListener("abort", rejectForAbort);
          resolve(value);
        },
        (error) => {
          if (finished) {
            return;
          }
          finished = true;
          attempt.signal.removeEventListener("abort", rejectForAbort);
          reject(error);
        }
      );
      if (attempt.signal.aborted) {
        rejectForAbort();
      }
    });
  }

  #transition(event) {
    const transitions = {
      active: { fail: "failed", stop: "stopping" },
      closed: { start: "opening-media" },
      failed: { closed: "closed" },
      negotiating: {
        connected: "active",
        fail: "failed",
        stop: "stopping",
      },
      "opening-media": {
        fail: "failed",
        "media-ready": "negotiating",
        stop: "stopping",
      },
      stopping: { closed: "closed" },
    };
    const next = transitions[this.#state]?.[event];
    if (!next) {
      throw new Error(`Invalid voice transition: ${this.#state} -> ${event}`);
    }
    this.#state = next;
  }

  #clearTimeout() {
    if (this.#attempt?.timeout !== undefined) {
      clearTimeout(this.#attempt.timeout);
      this.#attempt.timeout = undefined;
    }
  }
}
