/**
 * Shows questionnaire prompts one at a time, in arrival order. Pi stacks `ctx.ui` prompts with the
 * newest on top, so a new question would otherwise cover a form the user is still filling in.
 */
export const createPromptQueue = () => {
  let tail = Promise.resolve();

  return async <T>(
    signal: AbortSignal,
    show: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const previous = tail;
    const released = Promise.withResolvers<undefined>();
    tail = (async () => {
      await previous;
      await released.promise;
    })();

    const aborted = Promise.withResolvers<never>();

    const abort = () => {
      aborted.reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });

    try {
      signal.throwIfAborted();
      // A waiting prompt stops waiting when its signal aborts; later prompts still wait their turn.
      await Promise.race([previous, aborted.promise]);

      return await show(signal);
    } finally {
      signal.removeEventListener("abort", abort);
      released.resolve(undefined);
    }
  };
};
