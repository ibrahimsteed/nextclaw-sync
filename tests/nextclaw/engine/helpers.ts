// Minimal host clock used only by the existing plan-history formatter.
(globalThis as any).window ??= {};
(globalThis as any).window.moment = (n: number) => ({
  format: () => new Date(n).toISOString(),
  toISOString: () => new Date(n).toISOString(),
});
import type { Entity } from "../../../src/baseTypes";
import type { InternalDBs, NextclawSyncRecord } from "../../../src/localdb";
import type { SyncInput } from "../../../src/nextclaw/syncEngine";
import { FakeFs } from "../../../src/fsAll";
import { effectiveIgnorePaths } from "../../../src/nextclaw/branch";
export const bytes = (s: string) =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
export const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
export class MemoryFs extends FakeFs {
  kind: string;
  files = new Map<string, { entity: Entity; bytes: ArrayBuffer }>();
  calls: { op: string; key: string }[] = [];
  trash = new Map<string, ArrayBuffer>();
  root = true;
  serverTime = 200000;
  fail: (op: string, key: string) => boolean = () => false;
  latency = 0;
  active = 0;
  peak = 0;
  constructor(kind = "local") {
    super();
    this.kind = kind;
  }
  put(key: string, content = "x", mtime = 10000) {
    this.files.set(key.normalize("NFC"), {
      entity: {
        key,
        keyRaw: key,
        size: key.endsWith("/") ? 0 : bytes(content).byteLength,
        sizeRaw: key.endsWith("/") ? 0 : bytes(content).byteLength,
        mtimeCli: mtime,
        mtimeSvr: mtime,
        ctimeCli: mtime,
      },
      bytes: bytes(content),
    });
    return this;
  }
  async check(op: string, key: string) {
    this.calls.push({ op, key });
    if (this.fail(op, key)) throw new Error(`injected ${op}`);
  }
  async walk() {
    await this.check("walk", "");
    return [...this.files.values()].map((v) => ({ ...v.entity }));
  }
  async walkPartial() {
    return this.walk();
  }
  async stat(key: string) {
    await this.check("stat", key);
    if (key === "/" && this.root) return { key: "/", keyRaw: "/", sizeRaw: 0 };
    const item =
      this.files.get(key.normalize("NFC")) ??
      this.files.get(`${key.normalize("NFC")}/`);
    if (!item)
      throw Object.assign(new Error(`${key} does not exist`), {
        code: "ENOENT",
        status: 404,
      });
    return { ...item.entity };
  }
  async mkdir(key: string) {
    await this.check("mkdir", key);
    this.put(key);
    return this.stat(key);
  }
  async readFile(key: string) {
    await this.check("readFile", key);
    const item = this.files.get(key.normalize("NFC"));
    if (!item) throw new Error("missing file");
    return item.bytes.slice(0);
  }
  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ) {
    await this.check("writeFile", key);
    this.peak = Math.max(this.peak, ++this.active);
    try {
      if (this.latency) await new Promise((r) => setTimeout(r, this.latency));
      this.put(
        key,
        text(content),
        this.kind === "webdav"
          ? this.serverTime
          : Math.floor(mtime / 1000) * 1000
      );
      const stored = this.files.get(key.normalize("NFC"))!;
      stored.bytes = content.slice(0);
      stored.entity.size = content.byteLength;
      stored.entity.sizeRaw = content.byteLength;
      return await this.stat(key);
    } finally {
      this.active--;
    }
  }
  async rm(key: string) {
    await this.check("rm", key);
    const normalized = key.normalize("NFC").replace(/\/$/, "");
    for (const [p, item] of this.files)
      if (
        p.replace(/\/$/, "") === normalized ||
        p.startsWith(`${normalized}/`)
      ) {
        this.trash.set(p, item.bytes);
        this.files.delete(p);
      }
  }
  async rename() {
    throw new Error("rename not used");
  }
  async checkConnect() {
    return true;
  }
  async getUserDisplayName() {
    return "test";
  }
  async revokeAuth() {}
  allowEmptyFile() {
    return true;
  }
  writes() {
    return this.calls.filter((x) =>
      ["writeFile", "mkdir", "rm"].includes(x.op)
    );
  }
}
export function record(
  key = "note.md",
  opts: Partial<NextclawSyncRecord> = {}
): NextclawSyncRecord {
  return {
    v: 1,
    key,
    keyRaw: key,
    sizeRaw: 1,
    isFolder: key.endsWith("/"),
    local: { mtime: 10000, size: 1 },
    remote: { mtime: 10000, size: 1 },
    ...opts,
  };
}
export function harness(mode: "A" | "B" = "B") {
  (globalThis as any).window ??= {};
  (globalThis as any).window.moment = (n: number) => ({
    format: () => new Date(n).toISOString(),
    toISOString: () => new Date(n).toISOString(),
  });
  const local = new MemoryFs(),
    remote = new MemoryFs("webdav");
  const records: Record<string, unknown> = {};
  const plans: any[] = [];
  const events: any[][] = [];
  let recordWrites = 0;
  const db = {
    prevSyncRecordsTbl: {
      async getItems() {
        return structuredClone(records);
      },
      async keys() {
        return Object.keys(records);
      },
      async setItem(k: string, v: unknown) {
        recordWrites++;
        records[k] = structuredClone(v);
      },
      async removeItem(k: string) {
        recordWrites++;
        delete records[k];
      },
      async removeItems(ks: string[]) {
        for (const k of ks) delete records[k];
      },
    },
    syncPlansTbl: {
      async setItem(k: string, v: any) {
        plans.push(JSON.parse(v.syncPlan));
      },
    },
  } as unknown as InternalDBs;
  const input: SyncInput = {
    mode,
    fsLocal: local,
    fsRemote: remote,
    db,
    vaultRandomID: "v",
    profileID: "p",
    configDir: ".obsidian",
    syncConfigDir: true,
    pluginId: "nextclaw-sync",
    ignorePaths: effectiveIgnorePaths([], "nextclaw-sync", ".obsidian"),
    protectModifyPercentage: 100,
    concurrency: 5,
    triggerSource: "manual",
    callbacks: {
      markIsSyncing: (v) => {
        events.push(["mark", v]);
      },
      notify: (s, n) => {
        events.push(["notify", n]);
      },
      ribbon: (s, n) => {
        events.push(["ribbon", n]);
      },
      statusBar: (s, n, ok) => {
        events.push(["status", n, ok]);
      },
      progress: (s, ...v) => {
        events.push(["progress", ...v]);
      },
      errNotify: (s, e) => {
        events.push(["error", e]);
      },
      protectError: (p, c, t) => `protect ${p} ${c}/${t}`,
    },
  };
  return {
    input,
    local,
    remote,
    records,
    plans,
    events,
    saved: () => recordWrites,
    seed: (r: NextclawSyncRecord | any) => {
      records[`v\tp\t${r.key}`] = r;
    },
    rec: (key = "note.md") => records[`v\tp\t${key}`] as NextclawSyncRecord,
    last: () => plans[plans.length - 1],
  };
}
