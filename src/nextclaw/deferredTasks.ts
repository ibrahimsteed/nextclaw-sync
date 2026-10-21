/** Delayed startup/maintenance work belongs to a single plugin load. */
export class DeferredTasks {
  private readonly timers = new Set<number>();
  private stopped = false;
  private readonly waits = new Map<number, () => void>();

  get disposed() { return this.stopped; }

  constructor(private readonly clock: {
    setTimeout(callback: () => void, delay: number): number;
    clearTimeout(timer: number): void;
  } = window) {}

  run(task: () => void | Promise<unknown>) {
    if (this.disposed) return;
    void Promise.resolve().then(() => {
      if (!this.disposed) return task();
    }).catch((error: unknown) => {
      if (!this.disposed) console.error("NextClaw deferred task failed",
          error instanceof Error ? error.stack ?? error.message : String(error));
    });
  }

  schedule(task: () => void | Promise<unknown>, delay: number) {
    if (this.disposed) return;
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      this.run(task);
    }, delay);
    this.timers.add(timer);
  }

  wait(delay: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Plugin unloaded"));
    return new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.waits.delete(timer);
        if (this.disposed) reject(new Error("Plugin unloaded"));
        else resolve();
      }, delay);
      this.waits.set(timer, () => reject(new Error("Plugin unloaded")));
    });
  }

  dispose() {
    if (this.disposed) return;
    this.stopped = true;
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const [timer, cancel] of this.waits) { this.clock.clearTimeout(timer); cancel(); }
    this.waits.clear();
  }
}
