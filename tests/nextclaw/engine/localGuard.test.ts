import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import * as path from "path";
import { bytes, text } from "./helpers";

const code = buildSync({
  entryPoints: [path.resolve(__dirname, "../../../src/fsLocal.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["obsidian"],
  logLevel: "silent",
}).outputFiles[0].text;
function host(renameOverwrites = false) {
  const files = new Map<string, ArrayBuffer>();
  const directories = new Set(["", ".obsidian"]);
  let beforeProcess = () => {},
    beforeRename = () => {},
    beforeCopy = () => {};
  const adapter = {
    exists: async (p: string) => files.has(p) || directories.has(p),
    stat: async (p: string) =>
      files.has(p)
        ? {
            type: "file",
            size: files.get(p)!.byteLength,
            mtime: 10000,
            ctime: 10000,
          }
        : null,
    readBinary: async (p: string) => {
      if (!files.has(p)) throw new Error("missing");
      return files.get(p)!.slice(0);
    },
    process: async (p: string, fn: (s: string) => string) => {
      beforeProcess();
      files.set(p, bytes(fn(text(files.get(p)!))));
    },
    rename: async (p: string, q: string) => {
      beforeRename();
      if (q === "new.md") beforeCopy();
      if (files.has(q) && !renameOverwrites) throw new Error("exists");
      const b = files.get(p);
      if (!b) throw new Error("missing");
      files.set(q, b);
      files.delete(p);
    },
    writeBinary: async (p: string, b: ArrayBuffer) => {
      if (
        !directories.has(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")
      )
        throw new Error("Parent folder does not exist");
      files.set(p, b.slice(0));
    },
    copy: async (p: string, q: string) => {
      beforeCopy();
      if (files.has(q)) throw new Error("exists");
      files.set(q, files.get(p)!.slice(0));
    },
    remove: async (p: string) => {
      files.delete(p);
    },
    rmdir: async () => {},
    mkdir: async (p: string) => {
      directories.add(p);
    },
  };
  const vault = {
    adapter,
    createBinary: async (p: string, b: ArrayBuffer) => {
      if (files.has(p)) throw new Error("exists");
      files.set(p, b.slice(0));
    },
    getAbstractFileByPath: () => null,
  };
  const mod = { exports: {} as any };
  const load = (n: string) =>
    n === "obsidian"
      ? { TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p }
      : require(n);
  new Function("require", "module", "exports", code)(load, mod, mod.exports);
  const fs = new mod.exports.FakeFsLocal(
    vault,
    true,
    false,
    ".obsidian",
    "nextclaw-sync",
    "obsidian"
  );
  return {
    files,
    fs,
    setBeforeCopy: (fn: () => void) => {
      beforeCopy = fn;
    },
    setBeforeProcess: (fn: () => void) => (beforeProcess = fn),
    setBeforeRename: (fn: () => void) => (beforeRename = fn),
  };
}
describe("real local adapter mutation guards", () => {
  it("creates missing files and refuses existing same-name files", async () => {
    const h = host();
    await h.fs.writeFileGuarded("a.md", bytes("new"), 10000, 10000, null);
    await assert.rejects(
      h.fs.writeFileGuarded("a.md", bytes("overwrite"), 10000, 10000, null)
    );
    assert.equal(text(h.files.get("a.md")!), "new");
  });
  it("atomic text process rejects a same-size edit after the last stat", async () => {
    const h = host();
    h.files.set("a.md", bytes("old"));
    const version = await h.fs.stat("a.md");
    h.setBeforeProcess(() => h.files.set("a.md", bytes("NEW")));
    await assert.rejects(
      h.fs.writeFileGuarded(
        "a.md",
        bytes("remote"),
        10000,
        10000,
        version,
        bytes("old")
      )
    );
    assert.equal(text(h.files.get("a.md")!), "NEW");
  });
  it("text replacement uses exact bytes and returns measured metadata", async () => {
    const h = host();
    h.files.set("a.json", bytes("old"));
    const version = await h.fs.stat("a.json");
    const stored = await h.fs.writeFileGuarded(
      "a.json",
      bytes("remote"),
      10000,
      10000,
      version,
      bytes("old")
    );
    assert.equal(text(h.files.get("a.json")!), "remote");
    assert.equal(stored.size, 6);
  });
  it("binary replacement retains the old bytes", async () => {
    const h = host(),
      old = new Uint8Array([255, 0, 1]).buffer,
      next = new Uint8Array([254, 0, 2]).buffer;
    h.files.set("a.bin", old);
    const version = await h.fs.stat("a.bin");
    await h.fs.writeFileGuarded("a.bin", next, 10000, 10000, version, old);
    assert.deepEqual(h.files.get("a.bin"), next);
    assert.ok(
      [...h.files].some(
        ([p, b]) =>
          p.startsWith(".trash/nextclaw-recovery-") &&
          Buffer.from(b).equals(Buffer.from(old))
      )
    );
  });
  it("a deletion racing a new edit retains and restores the actual moved version", async () => {
    const h = host();
    h.files.set("a.md", bytes("old"));
    const version = await h.fs.stat("a.md");
    h.setBeforeRename(() => h.files.set("a.md", bytes("late edit")));
    await assert.rejects(h.fs.rmGuarded("a.md", version, bytes("old")), /保留/);
    assert.equal(text(h.files.get("a.md")!), "late edit");
    assert.ok(
      [...h.files].some(
        ([p, b]) => p.startsWith(".trash/") && text(b) === "late edit"
      )
    );
  });
});

describe("exclusive creation on hidden paths", () => {
  it("supports configuration files absent from the Vault index", async () => {
    const h = host();
    await h.fs.writeFileGuarded(
      ".obsidian/new.json",
      bytes("{}"),
      10000,
      10000,
      null
    );
    assert.equal(text(h.files.get(".obsidian/new.json")!), "{}");
  });
  it("refuses a same-name creation immediately before exclusive publication", async () => {
    const h = host();
    h.setBeforeCopy(() => h.files.set("new.md", bytes("concurrent")));
    await assert.rejects(
      h.fs.writeFileGuarded("new.md", bytes("incoming"), 10000, 10000, null),
      /同名/
    );
    assert.equal(text(h.files.get("new.md")!), "concurrent");
    assert.ok(
      [...h.files].some(
        ([p, b]) =>
          p.startsWith(".trash/nextclaw-staging-") && text(b) === "incoming"
      )
    );
  });
});

describe("unsupported host capability fails before destructive replacement", () => {
  it("rejects publication when the host rename would overwrite", async () => {
    const h = host(true);
    await assert.rejects(
      h.fs.writeFileGuarded("new.md", bytes("incoming"), 10000, 10000, null),
      /本设备/
    );
    assert.equal(h.files.has("new.md"), false);
  });
  it("does not move an existing binary before checking host capability", async () => {
    const h = host(true),
      old = new Uint8Array([255, 0, 1]).buffer;
    h.files.set("a.bin", old);
    await assert.rejects(
      h.fs.writeFileGuarded(
        "a.bin",
        new Uint8Array([254, 0, 2]).buffer,
        10000,
        10000,
        await h.fs.stat("a.bin"),
        old
      ),
      /本设备/
    );
    assert.deepEqual(h.files.get("a.bin"), old);
  });
});

describe("local discovery uses the same metadata source as mutation guards", () => {
  function scannedHost(stat: () => Promise<any>) {
    class TFile {
      path = "downloaded.md";
      // Android can report a watcher timestamp here after a timestamped download.
      stat = { mtime: 19000, ctime: 18000, size: 3 };
    }
    const mod = { exports: {} as any };
    const load = (name: string) => name === "obsidian"
      ? { TFile, TFolder: class {}, normalizePath: (p: string) => p }
      : require(name);
    new Function("require", "module", "exports", code)(load, mod, mod.exports);
    const fs = new mod.exports.FakeFsLocal({
      adapter: { stat }, getAllLoadedFiles: () => [new TFile()],
    }, false, false, ".obsidian", "nextclaw-sync", "obsidian");
    return fs;
  }
  it("uses measured size and mtime instead of the stale Vault cache", async () => {
    const fs = scannedHost(async () => ({ type: "file", mtime: 18000, ctime: 18000, size: 40 }));
    const [observed] = await fs.walk();
    assert.equal(observed.size, 40);
    assert.equal(observed.mtimeCli, 18000);
    const measured = await fs.stat(observed.key);
    assert.equal(observed.mtimeCli, measured.mtimeCli);
  });
  it("ignores a cached entry already missing on disk", async () => {
    const fs = scannedHost(async () => null);
    assert.deepEqual(await fs.walk(), []);
  });
  it("does not treat an I/O error as a deleted local file", async () => {
    const fs = scannedHost(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    await assert.rejects(fs.walk(), /denied/);
  });
});
