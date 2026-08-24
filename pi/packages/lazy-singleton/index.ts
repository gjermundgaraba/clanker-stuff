type Dispose<T> = (value: T) => Promise<void> | void;

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

  const stop = (dispose?: Dispose<T>): Promise<void> => {
    if (stopping !== undefined) {
      return stopping;
    }
    const value = current;
    const attempt = pending;
    lifetime.abort();
    stopping = (async () => {
      let loaded = value;
      if (loaded === undefined && attempt !== undefined) {
        try {
          loaded = await attempt;
        } catch {
          return;
        }
      }
      if (loaded !== undefined) {
        await dispose?.(loaded);
      }
    })();
    return stopping;
  };

  return {
    get: (): T | undefined => current,
    isLoading: (): boolean => pending !== undefined,
    isStopped: (): boolean => lifetime.signal.aborted,
    load,
    stop,
  };
};
