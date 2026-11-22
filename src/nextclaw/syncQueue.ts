/** Coalesced follow-up intent. No recursive retries or overlapping runs. */
export class SyncQueue {
  private dirty = false;
  private timer?: ReturnType<Window["setTimeout"]>;
  private failures = 0;
  private stopped = false;
  constructor(
    private readonly run: () => Promise<"ok" | "failed" | "blocked">,
    // Capture the owning window once so native timer calls retain their receiver.
    private readonly clock: {
      setTimeout(fn: () => void, delay: number): ReturnType<Window["setTimeout"]>;
      clearTimeout(handle: ReturnType<Window["setTimeout"]>): void;
    } = window
  ) {}
  request(delay = 0) {
    if (this.stopped) return;
    this.dirty = true;
    this.failures = 0;
    this.schedule(delay);
  }
  /** Called after the outer sync guard is released, including failed runs. */
  finished(outcome: "ok" | "failed" | "blocked") {
    if (this.stopped) return;
    if (outcome === "failed") {
      this.dirty = true;
      this.failures++;
      if (this.failures <= 5)
        this.schedule(
          Math.min(60000, 5000 * 2 ** Math.min(this.failures - 1, 4))
        );
    } else if (outcome === "ok") {
      this.failures = 0;
      if (this.dirty) this.schedule(0);
    }
    // Account/policy/confirmation blocks never start a retry loop.
  }
  private schedule(delay: number) {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || !this.dirty) return;
      this.dirty = false;
      void this.run().then(
        (outcome) => {
          if (outcome === "blocked") this.dirty = true;
        },
        () => this.finished("failed")
      );
    }, delay);
  }
  dispose() {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
