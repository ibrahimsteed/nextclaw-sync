import { nanoid } from "nanoid";
import {
  assertVersion,
  equalBytes,
  SyncConflict,
} from "./nextclaw/engine/versionGuard";
import { DEFAULT_DEBUG_FOLDER, type Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

import { TFile, TFolder, type Vault } from "obsidian";
import { mkdirpInVault, statFix, unixTimeToStr } from "./misc";
import { listFilesInObsFolder } from "./obsFolderLister";

export class FakeFsLocal extends FakeFs {
  vault: Vault;
  syncConfigDir: boolean;
  syncBookmarks: boolean;
  configDir: string;
  pluginID: string;
  deleteToWhere: "obsidian" | "system";
  kind: "local";
  constructor(
    vault: Vault,
    syncConfigDir: boolean,
    syncBookmarks: boolean,
    configDir: string,
    pluginID: string,
    deleteToWhere: "obsidian" | "system"
  ) {
    super();

    this.vault = vault;
    this.syncConfigDir = syncConfigDir;
    this.syncBookmarks = syncBookmarks;
    this.configDir = configDir;
    this.pluginID = pluginID;
    this.deleteToWhere = deleteToWhere;
    this.kind = "local";
  }

  async walk(): Promise<Entity[]> {
    const local: Entity[] = [];

    const localTAbstractFiles = this.vault.getAllLoadedFiles();
    for (const entry of localTAbstractFiles) {
      let r: Entity | undefined = undefined;
      let key = entry.path;
      if (key.startsWith("/")) {
        // why?
        // just remove leading slash /
        key = key.slice(1);
      }

      if (entry.path === "/" || entry.path === "") {
        // ignore
        continue;
      } else if (entry instanceof TFile) {
        let mtimeLocal: number | undefined = entry.stat.mtime;
        if (mtimeLocal <= 0) {
          mtimeLocal = entry.stat.ctime;
        }
        if (mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        if (mtimeLocal === undefined) {
          throw Error(
            `Your file has last modified time 0: ${key}, don't know how to deal with it`
          );
        }
        r = {
          key: key, // local always unencrypted
          keyRaw: key,
          mtimeCli: mtimeLocal,
          mtimeSvr: mtimeLocal,
          size: entry.stat.size, // local always unencrypted
          sizeRaw: entry.stat.size,
        };
      } else if (entry instanceof TFolder) {
        key = `${key}/`;
        r = {
          key: key,
          keyRaw: key,
          size: 0,
          sizeRaw: 0,
        };
      } else {
        throw Error(`unexpected entry: ${entry.path}`);
      }

      // 调试文件夹不参与同步。
      if (!r.keyRaw.startsWith(DEFAULT_DEBUG_FOLDER)) {
        local.push(r);
      }
    }

    if (this.syncConfigDir || this.syncBookmarks) {
      const bookmarksOnly = !this.syncConfigDir;
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        bookmarksOnly
      );
      // console.debug(`syncFiles in obs: ${JSON.stringify(syncFiles, null, 2)}`);
      for (const f of syncFiles) {
        local.push(f);
      }
    }

    return local;
  }

  async stat(key: string): Promise<Entity> {
    const statRes = await statFix(this.vault, key);
    if (statRes === undefined || statRes === null) {
      throw Object.assign(
        new Error(`${key} does not exist! cannot stat for local`),
        { code: "ENOENT" }
      );
    }
    const isFolder = statRes.type === "folder";
    return {
      key: isFolder ? `${key}/` : key, // local always unencrypted
      keyRaw: isFolder ? `${key}/` : key,
      ctimeCli: statRes.ctime,
      mtimeCli: statRes.mtime,
      mtimeSvr: statRes.mtime,
      ctimeCliFmt: unixTimeToStr(statRes.ctime),
      mtimeCliFmt: unixTimeToStr(statRes.mtime),
      mtimeSvrFmt: unixTimeToStr(statRes.mtime),
      size: statRes.size, // local always unencrypted
      sizeRaw: statRes.size,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    // console.debug(`mkdir: ${key}`);
    await mkdirpInVault(key, this.vault);
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    await this.vault.adapter.writeBinary(key, content, {
      mtime: mtime,
      ctime: ctime,
    });
    return await this.stat(key);
  }

  async writeFileGuarded(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expected: Entity | null,
    expectedBytes?: ArrayBuffer
  ): Promise<Entity> {
    await assertVersion(this, key, expected);
    if (!expected) {
      await this.createExclusive(key, content, mtime, ctime);
    } else {
      if (!expectedBytes) throw new SyncConflict("缺少本地版本快照");
      let oldText: string | undefined, newText: string | undefined;
      try {
        oldText = new TextDecoder("utf-8", { fatal: true }).decode(
          expectedBytes
        );
        newText = new TextDecoder("utf-8", { fatal: true }).decode(content);
        // A BOM or other non-roundtripping data must use binary preservation.
        if (
          !equalBytes(
            new TextEncoder().encode(oldText).buffer,
            expectedBytes
          ) ||
          !equalBytes(new TextEncoder().encode(newText).buffer, content)
        )
          oldText = undefined;
      } catch {
        oldText = undefined;
      }
      if (oldText !== undefined && newText !== undefined) {
        await this.vault.adapter.process(
          key,
          (current) => {
            if (current !== oldText) throw new SyncConflict();
            return newText;
          },
          { mtime, ctime }
        );
      } else {
        // No binary CAS in Obsidian: retain the version actually moved, including
        // edits racing the last check. Never unlink that retained version.
        await this.ensureExclusiveRename();
        await this.retainForRemoval(key, expectedBytes);
        await this.createExclusive(key, content, mtime, ctime);
      }
    }
    const stored = await this.stat(key);
    if (!equalBytes(await this.readFile(key), content))
      throw new SyncConflict();
    return stored;
  }

  private static exclusiveRename = new WeakMap<object, Promise<void>>();

  private async ensureExclusiveRename() {
    const adapter = this.vault.adapter;
    let probe = FakeFsLocal.exclusiveRename.get(adapter);
    if (!probe) {
      probe = (async () => {
        const parent = `.trash/nextclaw-probe-${nanoid()}`;
        await mkdirpInVault(`${parent}/`, this.vault);
        const source = `${parent}/source`,
          target = `${parent}/target`;
        const marker = new TextEncoder().encode("target-must-survive").buffer;
        let rejected = false;
        try {
          await adapter.writeBinary(
            source,
            new TextEncoder().encode("source").buffer
          );
          await adapter.writeBinary(target, marker);
          try {
            await adapter.rename(source, target);
          } catch {
            rejected = true;
          }
          if (
            !rejected ||
            !equalBytes(await adapter.readBinary(target), marker)
          )
            throw new SyncConflict(
              "本设备不支持拒绝覆盖的文件改名，暂停本地新建与二进制替换"
            );
        } finally {
          for (const file of [source, target])
            if (await adapter.exists(file)) await adapter.remove(file);
          await adapter.rmdir(parent, false);
        }
      })();
      FakeFsLocal.exclusiveRename.set(adapter, probe);
    }
    await probe;
  }

  private async createExclusive(
    key: string,
    bytes: ArrayBuffer,
    mtime: number,
    ctime: number
  ) {
    // Android copy overwrites despite its SDK contract. Probe the real host's
    // rename behavior before relying on no-clobber publication; fail closed otherwise.
    await this.ensureExclusiveRename();
    const parent = `.trash/nextclaw-staging-${nanoid()}`;
    await mkdirpInVault(`${parent}/`, this.vault);
    const staged = `${parent}/incoming`;
    await this.vault.adapter.writeBinary(staged, bytes, { mtime, ctime });
    try {
      await this.vault.adapter.rename(staged, key);
    } catch (error) {
      throw new SyncConflict(
        `新文件未覆盖同名路径，待传内容保留在 ${staged}：${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.vault.adapter.rmdir(parent, false);
  }

  private async retainForRemoval(key: string, expectedBytes: ArrayBuffer) {
    const parent = `.trash/nextclaw-recovery-${nanoid()}`;
    await mkdirpInVault(`${parent}/`, this.vault);
    const retained = `${parent}/${key.split("/").pop()!}`;
    await this.vault.adapter.rename(key, retained);
    const bytes = await this.vault.adapter.readBinary(retained);
    if (!equalBytes(bytes, expectedBytes)) {
      // Restore only via create-if-absent; never overwrite a newly recreated path.
      try {
        await this.createExclusive(key, bytes, Date.now(), Date.now());
      } catch {
        /* retained stays intact */
      }
      throw new SyncConflict(`删除前文件又有修改，版本保留在 ${retained}`);
    }
  }

  async rmGuarded(
    key: string,
    expected: Entity,
    expectedBytes?: ArrayBuffer
  ): Promise<void> {
    if (key.endsWith("/"))
      throw new SyncConflict("目录删除暂缓，保留可能新建的子文件");
    await assertVersion(this, key, expected);
    if (!expectedBytes) throw new SyncConflict("缺少本地删除快照");
    await this.retainForRemoval(key, expectedBytes);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.vault.adapter.readBinary(key);
  }

  async rename(key1: string, key2: string): Promise<void> {
    return await this.vault.adapter.rename(key1, key2);
  }

  async rm(key: string): Promise<void> {
    if (this.deleteToWhere === "obsidian") {
      await this.vault.adapter.trashLocal(key);
    } else {
      // "system"
      if (!(await this.vault.adapter.trashSystem(key))) {
        await this.vault.adapter.trashLocal(key);
      }
    }
  }
}
