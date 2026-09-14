/**
 * A→B 切换：删掉本地除配置目录外的全部内容、清空同步记录。
 *
 * 时间戳只解决"配置谁覆盖谁"，**解决不了"欢迎库内容被带进学生库"**——
 * A 阶段用过的本地 vault 里留着欢迎库的文件，切到双向后会被推上去。
 */
import { type InternalDBs, clearAllPrevSyncRecordByVault } from "../localdb";

/** 切换回执。出问题时这是唯一能追的线索，务必写进日志。 */
export interface SwitchReceipt {
  /** 已删除的顶层条目（进回收站，非永久删除）；文件夹以 `/` 结尾。 */
  deleted: string[];
  /** **故意跳过**的顶层条目：配置目录、回收站本身。 */
  skipped: string[];
  /** 枚举时在、删时已不存在——正常，不算失败。 */
  alreadyGone: string[];
  /** 删除失败的，连同原因。 */
  failed: { key: string; error: string }[];
  clearedPrevSync: boolean;
}

/** 回收站目录。删除就是挪进这里，删它自己没有意义。 */
const TRASH_DIR = ".trash";

/** `a/b/c.md` → `a/`；`x.md` → `x.md`。 */
const topLevelOf = (key: string): string => {
  const i = key.indexOf("/");
  return i < 0 ? key : key.slice(0, i + 1);
};

/**
 * 删除清单**来自本地枚举**（`fsLocal.walk()`），不来自 `prevSync`。
 *
 * ### 为什么不能按 `prevSync` 删
 *
 * 同步记录只记**两边都有**的文件。A 分支只拉不推，用户在 A 阶段新建的笔记
 * 远端永远没有，也就**永远不在 `prevSync` 里**——按 `prevSync` 删一定漏，
 * 漏掉的在切到双向后会被当成本地新建推进学生库。
 *
 * 产品要求欢迎库里写的东西**一概不带进学生库**，因此切换时删掉本地
 * 配置目录以外的全部内容。删除走回收站，误删也捞得回来。
 *
 * ### 删什么、怎么删
 *
 * - 只删**顶层条目**：文件夹整体挪进回收站，目录结构原样保留，恢复时不用拼。
 *   子路径即使枚举里缺了父文件夹条目，也按首段归并到顶层，不会漏。
 * - **不删配置目录**：本地是欢迎库的配置（领先最多 30 分钟），远端学生库领先
 *   90 分钟，按"mtime 新者胜"学生库的配置赢。删了反而要和正在运行的
 *   Obsidian 抢写同一批文件。插件自身也在配置目录里，删了就没法继续同步。
 * - **不删 `.trash`**：删除就是挪进它。
 * - 配置目录名跟随 vault 的实际取值，不写死 `.obsidian`。
 *
 * ### 失败时
 *
 * 枚举抛异常（例如某文件 mtime 为 0）会整体抛出：调用方不清标记，下次同步重来。
 * 单个条目删除失败只进回执，不中断其余条目。
 */
export const switchAtoB = async (params: {
  db: InternalDBs;
  vaultRandomID: string;
  fsLocal: {
    walk(): Promise<{ key?: string; keyRaw: string }[]>;
    rm(key: string): Promise<void>;
  };
  configDir: string;
}): Promise<SwitchReceipt> => {
  const { db, vaultRandomID, fsLocal, configDir } = params;

  const receipt: SwitchReceipt = {
    deleted: [],
    skipped: [],
    alreadyGone: [],
    failed: [],
    clearedPrevSync: false,
  };

  const entries = await fsLocal.walk();
  const tops = new Set<string>();
  for (const e of entries) {
    const key = (e.key ?? e.keyRaw ?? "").replace(/^\/+/, "");
    if (key !== "") tops.add(topLevelOf(key));
  }
  const protectedTops = new Set([`${configDir}/`, configDir, `${TRASH_DIR}/`, TRASH_DIR]);

  // ① 删本地。排序只为回执稳定可读。
  for (const top of [...tops].sort()) {
    if (protectedTops.has(top)) {
      receipt.skipped.push(top);
      continue;
    }
    // 文件夹条目带尾斜杠，回收站接口要的是不带的路径。
    const target = top.endsWith("/") ? top.slice(0, -1) : top;
    try {
      await fsLocal.rm(target);
      receipt.deleted.push(top);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not exist|ENOENT|no such file/i.test(msg)) {
        receipt.alreadyGone.push(top);
      } else {
        receipt.failed.push({ key: top, error: msg });
      }
    }
  }

  // ② 清空同步记录。不清的话，新远端的文件会被判成"两边都改过"而走冲突分支，
  //    行为不可预期；清空后两边都算"新建"，按 mtime 新者胜比较——
  //    正是本设计所依赖的路径。
  await clearAllPrevSyncRecordByVault(db, vaultRandomID);
  receipt.clearedPrevSync = true;

  return receipt;
};

/** 回执的单行摘要，写进日志用。 */
export const formatReceipt = (r: SwitchReceipt): string =>
  `NextClaw A→B: 删除 ${r.deleted.length}、跳过 ${r.skipped.length}、` +
  `本已不存在 ${r.alreadyGone.length}、失败 ${r.failed.length}、` +
  `同步记录${r.clearedPrevSync ? "已清空" : "未清空"}` +
  (r.failed.length > 0
    ? `\n失败明细：${r.failed.map((x) => `${x.key}(${x.error})`).join(", ")}`
    : "") +
  (r.deleted.length > 0 ? `\n已删除：${r.deleted.join(", ")}` : "") +
  (r.skipped.length > 0 ? `\n已跳过：${r.skipped.join(", ")}` : "");
