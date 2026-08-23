export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  clear(): void {
    this.#tails.clear();
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = (async () => {
      await previous;
      return await operation();
    })();
    const tail = (async () => {
      try {
        await current;
      } catch {
        // Later operations still run after a failed predecessor.
      }
    })();
    this.#tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}
