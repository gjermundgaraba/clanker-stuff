export const createLazySingleton = <T extends object>(
  create: (signal: AbortSignal) => Promise<T>,
  onLoad?: (value: T) => void,
) => {
  const lifetime = new AbortController();
  let current: T | undefined;
  let pending: Promise<T> | undefined;
  let stopping: Promise<void> | undefined;

  const load = async (): Promise<T | undefined> => {
    if (lifetime.signal.aborted) {
      return undefined;
    }

    if (current !== undefined) {
      return current;
    }

    const attempt = (pending ??= create(lifetime.signal));

    try {
      const value = await attempt;

      if (lifetime.signal.aborted) {
        return undefined;
      }

      if (current === undefined) {
        current = value;
        onLoad?.(value);
      }

      return lifetime.signal.aborted ? undefined : current;
    } catch (error) {
      if (lifetime.signal.aborted) {
        return undefined;
      }

      throw error;
    } finally {
      if (pending === attempt) {
        pending = undefined;
      }
    }
  };

  const stop = (dispose?: (value: T) => Promise<void> | void): Promise<void> =>
    (stopping ??= (async () => {
      lifetime.abort();
      let loaded: T | undefined;

      try {
        loaded = current ?? (await pending);
      } catch {
        return;
      }

      if (loaded !== undefined) {
        await dispose?.(loaded);
      }
    })());

  return {
    get: (): T | undefined => current,
    isStopped: (): boolean => lifetime.signal.aborted,
    load,
    stop,
  };
};
