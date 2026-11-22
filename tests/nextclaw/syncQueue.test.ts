import { strict as assert } from "assert";
import { SyncQueue } from "../../src/nextclaw/syncQueue";

function clock() {
  let now = 0,
    id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn: () => void, delay: number) {
      timers.set(++id, { at: now + delay, fn });
      return id as any;
    },
    clearTimeout(handle: any) {
      timers.delete(handle);
    },
    async tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
    get size() {
      return timers.size;
    },
  };
}
describe("unified follow-up and recovery queue", () => {
  it("coalesces while busy and runs once after the owner completes", async () => {
    const c = clock();
    let busy = true,
      runs = 0;
    const q = new SyncQueue(async () => {
      if (busy) return "blocked";
      runs++;
      q.finished("ok");
      return "ok";
    }, c);
    q.request();
    q.request();
    await c.tick(0);
    assert.equal(runs, 0);
    busy = false;
    q.finished("ok");
    await c.tick(0);
    assert.equal(runs, 1);
    assert.equal(c.size, 0);
  });
  it("keeps intent on failure, backs off, then stops retrying after success", async () => {
    const c = clock();
    let runs = 0;
    const q = new SyncQueue(async () => {
      runs++;
      const result = runs < 3 ? "failed" : "ok";
      q.finished(result);
      return result;
    }, c);
    q.request();
    await c.tick(0);
    assert.equal(runs, 1);
    await c.tick(4999);
    assert.equal(runs, 1);
    await c.tick(1);
    assert.equal(runs, 2);
    await c.tick(9999);
    assert.equal(runs, 2);
    await c.tick(1);
    assert.equal(runs, 3);
    await c.tick(120000);
    assert.equal(runs, 3);
    assert.equal(c.size, 0);
  });
  it("policy blocks do not cause automatic retry storms", async () => {
    const c = clock();
    let runs = 0;
    const q = new SyncQueue(async () => {
      runs++;
      return "blocked";
    }, c);
    q.request();
    await c.tick(3600000);
    assert.equal(runs, 1);
    assert.equal(c.size, 0);
    q.request();
    await c.tick(0);
    assert.equal(runs, 2);
  });
  it("reconnect preempts backoff but preserves one scheduled retry", async () => {
    const c = clock();
    let runs = 0;
    const q = new SyncQueue(async () => {
      runs++;
      q.finished("failed");
      return "failed";
    }, c);
    q.request();
    await c.tick(0);
    q.request(3000);
    await c.tick(3000);
    assert.equal(runs, 2);
    assert.equal(c.size, 1);
  });
  it("unload cancels timers and late completions cannot revive the queue", async () => {
    const c = clock();
    let runs = 0;
    const q = new SyncQueue(async () => {
      runs++;
      return "ok";
    }, c);
    q.request(3000);
    q.dispose();
    q.finished("failed");
    q.request();
    await c.tick(100000);
    assert.equal(runs, 0);
    assert.equal(c.size, 0);
  });
});

describe("bounded retry budget", () => {
  it("stops after five retries until a new external trigger arrives", async () => {
    const c = clock();
    let runs = 0;
    const q = new SyncQueue(async () => {
      runs++;
      q.finished("failed");
      return "failed";
    }, c);
    q.request();
    await c.tick(3600000);
    assert.equal(runs, 6);
    assert.equal(c.size, 0);
    q.request(3000);
    await c.tick(3000);
    assert.equal(runs, 7);
    assert.equal(c.size, 1);
    q.dispose();
  });
});

describe("native timer receiver", () => {
  it("keeps the owning window as timer receiver through disposal", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    let scheduled = false, cleared = false;
    const owner = {
      setTimeout(this: unknown) {
        assert.equal(this, owner);
        scheduled = true;
        return 1;
      },
      clearTimeout(this: unknown, handle: number) {
        assert.equal(this, owner);
        assert.equal(handle, 1);
        cleared = true;
      },
    };
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: owner });
      const q = new SyncQueue(async () => "ok");
      q.request(3000);
      Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
      q.dispose();
      assert.equal(scheduled, true);
      assert.equal(cleared, true);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as any).window;
    }
  });
});
