/**
 * 装进已有笔记的库时的保护。
 *
 * NextClaw Sync 是为新建的空库设计的，装进已有笔记的库有两处会伤到用户：
 *
 * 1. **首次同步演示库**：配置目录没有同步记录时演示库直接胜（引擎规格 D9），
 *    `app.json`、`appearance.json`、`core-plugins.json`、`graph.json` 被整份替换，不备份；
 *    与演示库同名的文件也可能被直接覆盖。用户自己的笔记不动。
 * 2. **A→B 切换**：配置目录与 `.trash` 以外的全部内容移进 `.trash`（`switchAtoB.ts`）。
 *
 * 两处都先弹窗确认。判断"用户自己的内容"的依据是**同步记录**：
 * 演示库同步过的文件都有记录，没有记录的就是用户自己放进来的。
 * 全新的空库、或只同步过演示库的库，两处都不弹窗，按手册操作的学生看不到它。
 *
 * 自动触发的同步（启动后、定时、保存时）不弹窗：跳过本次同步，提示用户手动点一次同步确认。
 */

export type GuardKind = "first-demo-sync" | "switch-to-account";

export interface GuardDecision {
  kind: GuardKind;
  /** 用户自己的文件数（不含文件夹）。 */
  fileCount: number;
  /** 用户内容的顶层条目，供弹窗列出；文件夹以 `/` 结尾。 */
  topLevel: string[];
}

const TRASH_DIR = ".trash";
const LEGACY_DEBUG_FOLDER = "_debug_remotely_save/";
const DEBUG_FOLDER = "_nextclaw_debug/";

const norm = (key: string) => key.normalize("NFC").replace(/^\/+/, "");

const topLevelOf = (key: string): string => {
  const i = key.indexOf("/");
  return i < 0 ? key : key.slice(0, i + 1);
};

/**
 * 本地枚举中没有同步记录的内容（配置目录、`.trash`、调试文件夹除外）。
 * 只统计文件；只有空文件夹时不算有用户内容。
 */
export const findUserContent = (
  entries: { key?: string; keyRaw: string }[],
  recordKeys: string[],
  configDir: string
): { fileCount: number; topLevel: string[] } => {
  const recorded = new Set(recordKeys.map(norm));
  const config = `${norm(configDir).replace(/\/$/, "")}/`;
  const tops = new Set<string>();
  let fileCount = 0;
  for (const e of entries) {
    const key = norm(e.key ?? e.keyRaw);
    if (
      key === "" ||
      key.startsWith(config) ||
      key.startsWith(`${TRASH_DIR}/`) ||
      key.startsWith(DEBUG_FOLDER) ||
      key.startsWith(LEGACY_DEBUG_FOLDER) ||
      key.endsWith("/") ||
      recorded.has(key)
    ) {
      continue;
    }
    fileCount++;
    tops.add(topLevelOf(key));
  }
  return { fileCount, topLevel: [...tops].sort() };
};

/**
 * 本次同步是否需要先确认。返回 null 表示不需要。
 *
 * - A→B 切换待执行：库里有用户内容就确认；
 * - 模式 A、从未同步过（没有任何同步记录）、用户还没确认过：库里有用户内容就确认；
 * - 空跑不会改动文件，不确认。
 */
export const decideGuard = (p: {
  mode: "A" | "B";
  triggerSource: string;
  pendingSwitchToB: boolean;
  acknowledgedFirstDemoSync: boolean;
  hasAnyRecord: boolean;
  userContent: { fileCount: number; topLevel: string[] };
}): GuardDecision | null => {
  if (p.triggerSource === "dry" || p.userContent.fileCount === 0) {
    return null;
  }
  if (p.pendingSwitchToB) {
    return { kind: "switch-to-account", ...p.userContent };
  }
  if (p.mode === "A" && !p.hasAnyRecord && !p.acknowledgedFirstDemoSync) {
    return { kind: "first-demo-sync", ...p.userContent };
  }
  return null;
};

/** 只有手动点同步时才能弹窗；自动触发的同步跳过并提示。 */
export const canAskNow = (triggerSource: string): boolean =>
  triggerSource === "manual";

/**
 * 读取判断所需的数据并给出结论。只在可能需要确认时才枚举本地文件：
 * 已同步过演示库、或用户已确认过的库，模式 A 的日常同步只读一次同步记录。
 */
export const evaluateGuard = async (p: {
  mode: "A" | "B";
  triggerSource: string;
  pendingSwitchToB: boolean;
  acknowledgedFirstDemoSync: boolean;
  configDir: string;
  readRecordKeys: () => Promise<string[]>;
  walk: () => Promise<{ key?: string; keyRaw: string }[]>;
}): Promise<GuardDecision | null> => {
  if (p.triggerSource === "dry") {
    return null;
  }
  const mayAskDemo = p.mode === "A" && !p.acknowledgedFirstDemoSync;
  if (!p.pendingSwitchToB && !mayAskDemo) {
    return null;
  }
  const recordKeys = await p.readRecordKeys();
  if (!p.pendingSwitchToB && recordKeys.length > 0) {
    return null;
  }
  return decideGuard({
    mode: p.mode,
    triggerSource: p.triggerSource,
    pendingSwitchToB: p.pendingSwitchToB,
    acknowledgedFirstDemoSync: p.acknowledgedFirstDemoSync,
    hasAnyRecord: recordKeys.length > 0,
    userContent: findUserContent(await p.walk(), recordKeys, p.configDir),
  });
};
