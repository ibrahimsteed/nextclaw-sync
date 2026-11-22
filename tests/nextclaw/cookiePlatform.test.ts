import { strict as assert } from "assert";
import * as path from "path";
import { buildSync } from "esbuild";

// 真机实证的平台差异：iOS 空 Cookie 头抑制原生会话注入（207/Basic）；
// Android 桥不抑制注入且空头丢 same-site → Nextcloud 412，只能账号变化时清 jar。
function bundle() {
  return buildSync({
    entryPoints: [path.resolve(__dirname, "../../src/fsWebdav.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    external: ["obsidian", "webdav/dist/web/index.js"],
    logLevel: "silent",
  }).outputFiles[0].text;
}

function makeFs(
  platform: { isIosApp?: boolean; isAndroidApp?: boolean },
  config: Record<string, string> = {}
) {
  const captured: any[] = [];
  const client = {
    exists: async () => true,
    getDAVCompliance: async () => ({ compliance: [], server: "test" }),
  };
  const load = (name: string) =>
    name === "obsidian"
      ? { Platform: platform, requireApiVersion: () => false }
      : name === "webdav/dist/web/index.js"
        ? {
            createClient: (_addr: string, options: any) => {
              captured.push(options);
              return client;
            },
            AuthType: { Password: "password", Digest: "digest" },
            getPatcher: () => ({ patch() {} }),
          }
        : require(name);
  const mod = { exports: {} as any };
  new Function("require", "module", "exports", bundle())(
    load,
    mod,
    mod.exports
  );
  const fs = new mod.exports.FakeFsWebdav(
    {
      address: "https://cloud.example/remote.php/dav/files/u1",
      username: "u1",
      password: "not-a-credential",
      remoteBaseDir: "vault",
      manualRecursive: true,
      depth: "manual_1",
      ...config,
    },
    "test",
    async () => {}
  );
  return { fs, captured };
}

function mockEnv(opts: { withCapacitor?: boolean; failClear?: boolean } = {}) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  let clears = 0;
  const savedStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );
  const savedCapacitor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Capacitor"
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  if (opts.withCapacitor !== false) {
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: {
        Plugins: {
          CapacitorCookies: {
            clearAllCookies: async () => {
              clears++;
              if (opts.failClear) throw new Error("clear failed");
            },
          },
        },
      },
    });
  }
  return {
    clears: () => clears,
    marker: () => store.get("nextclaw-sync-android-cookie-account"),
    restore: () => {
      if (savedStorage)
        Object.defineProperty(globalThis, "localStorage", savedStorage);
      else delete (globalThis as any).localStorage;
      if (savedCapacitor)
        Object.defineProperty(globalThis, "Capacitor", savedCapacitor);
      else delete (globalThis as any).Capacitor;
    },
  };
}

describe("跨库会话 cookie 平台区分修复", () => {
  it("iOS：带空 Cookie 头抑制原生注入，不清 jar", async () => {
    const env = mockEnv();
    try {
      const { fs, captured } = makeFs({ isIosApp: true, isAndroidApp: false });
      await fs._init();
      assert.equal(captured[0].headers.cookie, "");
      assert.equal(env.clears(), 0);
      assert.equal(env.marker(), undefined);
    } finally {
      env.restore();
    }
  });
  it("iOS：customHeaders 仍可覆盖 Cookie", async () => {
    const env = mockEnv();
    try {
      const { fs, captured } = makeFs(
        { isIosApp: true },
        { customHeaders: "Cookie: custom" }
      );
      await fs._init();
      assert.equal(captured[0].headers.Cookie, "custom");
    } finally {
      env.restore();
    }
  });
  it("Android：不带 Cookie 头；账号变化清 jar，同账号不重复清", async () => {
    const env = mockEnv();
    try {
      const a = makeFs({ isAndroidApp: true });
      await a.fs._init();
      assert.equal("cookie" in a.captured[0].headers, false);
      assert.equal("Cookie" in a.captured[0].headers, false);
      assert.equal(env.clears(), 1);
      assert.equal(
        env.marker(),
        "https://cloud.example/remote.php/dav/files/u1|u1"
      );
      // 同账号另一个库：不清
      const b = makeFs({ isAndroidApp: true });
      await b.fs._init();
      assert.equal(env.clears(), 1);
      // 换账号：清
      const c = makeFs({ isAndroidApp: true }, { username: "u2" });
      await c.fs._init();
      assert.equal(env.clears(), 2);
      // 换服务器（同用户名）：清
      const d = makeFs(
        { isAndroidApp: true },
        { address: "https://other.example/dav/files/u1" }
      );
      await d.fs._init();
      assert.equal(env.clears(), 3);
    } finally {
      env.restore();
    }
  });
  it("Android：client 已缓存时账号变化仍触发清 jar", async () => {
    const env = mockEnv();
    try {
      const { fs } = makeFs({ isAndroidApp: true });
      await fs._init();
      assert.equal(env.clears(), 1);
      fs.webdavConfig.username = "u2";
      await fs._init();
      assert.equal(env.clears(), 2);
    } finally {
      env.restore();
    }
  });
  it("Android：无 Capacitor 不抛、不写标记，之后可用时仍会清", async () => {
    const env = mockEnv({ withCapacitor: false });
    try {
      const { fs } = makeFs({ isAndroidApp: true });
      await fs._init();
      assert.equal(env.marker(), undefined);
    } finally {
      env.restore();
    }
    const env2 = mockEnv();
    try {
      const { fs } = makeFs({ isAndroidApp: true });
      await fs._init();
      assert.equal(env2.clears(), 1);
    } finally {
      env2.restore();
    }
  });
  it("Android：清 jar 失败不阻断同步、不写标记，下次重试", async () => {
    const env = mockEnv({ failClear: true });
    try {
      const { fs } = makeFs({ isAndroidApp: true });
      await fs._init();
      assert.equal(env.clears(), 1);
      assert.equal(env.marker(), undefined);
      await fs._init();
      assert.equal(env.clears(), 2);
    } finally {
      env.restore();
    }
  });
  it("桌面：不带 Cookie 头也不清 jar（保持 0.2.8 基线行为）", async () => {
    const env = mockEnv();
    try {
      const { fs, captured } = makeFs({ isIosApp: false, isAndroidApp: false });
      await fs._init();
      assert.equal("cookie" in captured[0].headers, false);
      assert.equal(env.clears(), 0);
      assert.equal(env.marker(), undefined);
    } finally {
      env.restore();
    }
  });
});
