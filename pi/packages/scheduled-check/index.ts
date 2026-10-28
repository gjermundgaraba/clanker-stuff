export const createScheduledCheck = (check: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = 0;

  const clear = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };

  const request = (delayMs: number): void => {
    const nextDue = Date.now() + delayMs;

    if (timer !== undefined && due <= nextDue) {
      return;
    }

    clear();
    due = nextDue;
    timer = setTimeout(() => {
      timer = undefined;
      check();
    }, delayMs);
    timer.unref();
  };

  return { request, clear };
};
