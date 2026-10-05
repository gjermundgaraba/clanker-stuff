/**
 * Shows questionnaire prompts one at a time. Pi gives each `ctx.ui` prompt the editor slot
 * outright, so a second prompt would orphan the first one still awaiting input.
 */
export function createPromptQueue() {
  let tail = Promise.resolve();

  return async <T>(signal: AbortSignal, show: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const previous = tail;
    const released = Promise.withResolvers<void>();
    tail = previous.then(() => released.promise);
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });

    try {
      signal.throwIfAborted();
      // A waiting prompt stops waiting when its signal aborts; later prompts still wait their turn.
      await Promise.race([previous, aborted.promise]);

      return await show(signal);
    } finally {
      signal.removeEventListener("abort", abort);
      released.resolve();
    }
  };
}
