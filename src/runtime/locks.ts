export class KeyedLock {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => gate);
    this.queues.set(key, chain);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(key) === chain) {
        this.queues.delete(key);
      }
    }
  }
}
