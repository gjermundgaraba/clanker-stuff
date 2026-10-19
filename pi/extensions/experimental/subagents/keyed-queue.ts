export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  clear(): void {
    this.#tails.clear();
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const current = (this.#tails.get(key) ?? Promise.resolve()).then(operation);

    // Later operations still run after a failed predecessor.
    const tail = current.then(
      () => undefined,
      () => undefined,
    );

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
