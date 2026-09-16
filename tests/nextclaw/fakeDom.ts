/**
 * `changeMobileStatusBar` 用到的那一小撮浏览器 API 的替身。
 *
 * 它操作的是真实 DOM，而 mocha 里没有 DOM。这里只实现被用到的部分：
 * 类名、style 变量、getBoundingClientRect、querySelector、MutationObserver、
 * 以及 Obsidian 给 Node 挂的 `instanceOf` / `hasClass` 扩展。
 */

export class FakeEl {
  classes = new Set<string>();
  height = 0;
  props = new Map<string, string>();
  style = {
    setProperty: (k: string, v: string) => {
      this.props.set(k, v);
    },
    removeProperty: (k: string) => {
      this.props.delete(k);
    },
  };
  /** 传 `.mobile-navbar` 这样的选择器，类名即随之带上。 */
  constructor(readonly sel: string) {
    if (sel.startsWith(".")) {
      this.classes.add(sel.slice(1));
    }
  }
  addClass(c: string) {
    this.classes.add(c);
  }
  removeClass(c: string) {
    this.classes.delete(c);
  }
  hasClass(c: string) {
    return this.classes.has(c);
  }
  instanceOf(cls: unknown) {
    return this instanceof (cls as new () => unknown);
  }
  getBoundingClientRect() {
    return { height: this.height };
  }
}

type MutationLike = {
  type: string;
  addedNodes: FakeEl[];
  removedNodes: FakeEl[];
};

export class FakeDom {
  /** 选择器 → 元素。删掉一项表示那个元素已从 DOM 移除。 */
  els = new Map<string, FakeEl>();
  observerCallbacks: ((m: MutationLike[]) => void)[] = [];
  timers: (() => void)[] = [];
  private saved: Record<string, unknown> = {};

  add(sel: string, height = 0) {
    const el = new FakeEl(sel);
    el.height = height;
    this.els.set(sel, el);
    return el;
  }

  /** 安装全局替身；返回还原函数。 */
  install() {
    const dom = this;
    const g = globalThis as Record<string, any>;
    for (const k of [
      "activeDocument",
      "HTMLElement",
      "MutationObserver",
      "window",
    ]) {
      this.saved[k] = g[k];
    }
    g.HTMLElement = FakeEl;
    g.activeDocument = {
      querySelector: (sel: string) => dom.els.get(sel) ?? null,
    };
    g.MutationObserver = class {
      constructor(cb: (m: MutationLike[]) => void) {
        dom.observerCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    };
    g.window = {
      setTimeout: (fn: () => void) => {
        dom.timers.push(fn);
        return dom.timers.length;
      },
      clearTimeout: () => {},
    };
    return () => {
      for (const [k, v] of Object.entries(this.saved)) {
        g[k] = v;
      }
    };
  }

  /** 触发一次 DOM 变化通知。 */
  mutate(m: Partial<MutationLike>) {
    const full: MutationLike = {
      type: "childList",
      addedNodes: [],
      removedNodes: [],
      ...m,
    };
    for (const cb of this.observerCallbacks) {
      cb([full]);
    }
  }

  /** 跑掉所有挂起的 setTimeout 回调。 */
  runTimers() {
    const pending = this.timers;
    this.timers = [];
    for (const fn of pending) {
      fn();
    }
  }
}
