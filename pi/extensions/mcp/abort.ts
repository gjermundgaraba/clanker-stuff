/** Cancel a caller's wait without canceling work shared with other callers. */
export const awaitWithSignal = async <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  signal?.throwIfAborted();
  if (!signal) return await work;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
