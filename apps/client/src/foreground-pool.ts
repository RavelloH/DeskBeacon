/** One local foreground command pool per device runtime. No RPC scheduling or polling. */
export class ForegroundPool {
  private runningCount = 0;
  private readonly waiting: Array<{
    id: string;
    begin: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly capacity = 4, readonly maxQueued = 32) {
    if (!Number.isInteger(capacity) || capacity < 1) throw Error('INVALID_POOL_CAPACITY');
  }

  get active() { return this.runningCount; }
  get queued() { return this.waiting.length; }

  run<T>(id: string, work: () => Promise<T>, onStart?: () => void, waitMs = 60_000): Promise<T> {
    if (this.runningCount >= this.capacity && this.waiting.length >= this.maxQueued)
      return Promise.reject(Error('QUEUE_FULL: Device foreground queue is full'));
    return new Promise<T>((resolve, reject) => {
      const begin = () => {
        this.runningCount++;
        // Release the slot before resolving the caller; never strand waiting commands.
        const done = () => { this.runningCount--; this.pump(); };
        void Promise.resolve().then(() => onStart?.()).then(work).then(
          value => { done(); resolve(value); },
          error => { done(); reject(error); },
        );
      };
      if (this.runningCount < this.capacity && this.waiting.length === 0) {
        begin();
        return;
      }
      const entry = {
        id, begin, reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            reject(Error('QUEUE_TIMEOUT: Foreground command was not started'));
          }
        }, waitMs),
      };
      this.waiting.push(entry);
      this.pump();
    });
  }

  cancelPending(id: string): number {
    let cancelled = 0;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const task = this.waiting[i]!;
      if (task.id !== id && !task.id.startsWith(id + ':')) continue;
      this.waiting.splice(i, 1);
      clearTimeout(task.timer);
      task.reject(Error('CANCELLED: Foreground command cancelled before starting'));
      cancelled++;
    }
    return cancelled;
  }

  private pump() {
    while (this.runningCount < this.capacity && this.waiting.length) {
      const task = this.waiting.shift()!;
      clearTimeout(task.timer);
      task.begin();
    }
  }
}
