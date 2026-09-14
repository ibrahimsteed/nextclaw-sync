/**
 * A / B 分支判定。
 *
 * A = 所有新用户，只读展示**欢迎库**；B = 已开通用户，同步**自己的学生库**。
 */
import {
  NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE,
  NEXTCLAW_PUBLIC_SHARE_PASSWORD,
  NEXTCLAW_PUBLIC_SHARE_TOKEN,
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_USERNAME_PLACEHOLDER,
} from "./constants";

export type NextclawBranch = "A" | "B";

/**
 * 判据是**用户名**，不是"用户名和密码都非空"。
 *
 * 理由：可编辑性的规则是"用户名从为空变为不为空时才解锁"。若要求两者都非空，
 * 用户填完用户名、还没填密码的那段时间会卡在 A 分支、控件仍锁着，
 * 他根本没机会填密码——死锁。
 */
export const detectBranch = (webdav: { username?: string }): NextclawBranch =>
  (webdav.username ?? "").trim() === "" ? "A" : "B";

/** B 分支的地址：把模板里的 `{username}` 换成用户名。 */
export const accountAddressFor = (username: string): string =>
  NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE.replace(
    NEXTCLAW_USERNAME_PLACEHOLDER,
    encodeURIComponent(username.trim())
  );

const escapeRegExp = (x: string): string =>
  x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 认得出"由我们生成的地址"的形状：模板里 `{username}` 那一段换成任意非 `/` 内容。 */
const MANAGED_ADDRESS_RE = new RegExp(
  "^" +
    NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE.split(NEXTCLAW_USERNAME_PLACEHOLDER)
      .map(escapeRegExp)
      .join("[^/]*") +
    "$"
);

/**
 * 这个地址是不是"我们生成的"——空、公开分享地址、或账号模板的任一填充。
 *
 * 用来区分"该由我们跟着用户名重算"与"用户自己改成了别的 WebDAV 服务，别碰"。
 * 判据必须认模板**形状**而不是某个具体值：用户名是一个字符一个字符敲进来的，
 * 中途每一步都会生成一个形状相同、内容不同的地址。
 */
export const isManagedAddress = (address: string | undefined): boolean => {
  const a = (address ?? "").trim();
  return (
    a === "" || a === NEXTCLAW_PUBLIC_WEBDAV_URL || MANAGED_ADDRESS_RE.test(a)
  );
};

/**
 * 连接时**实际使用**的 WebDAV 配置。
 *
 * A 分支在这里注入公开分享的 token 与占位密码——**它们不写进设置**。
 * 一旦写进 `settings.webdav.username`，`detectBranch` 就永远判成 B，
 * 用户再也回不到欢迎库。
 */
export const effectiveWebdavConfig = <T extends { username?: string }>(
  webdav: T
): T => {
  if (detectBranch(webdav) === "B") {
    return webdav;
  }
  return {
    ...webdav,
    address: NEXTCLAW_PUBLIC_WEBDAV_URL,
    username: NEXTCLAW_PUBLIC_SHARE_TOKEN,
    password: NEXTCLAW_PUBLIC_SHARE_PASSWORD,
  };
};

/**
 * 把"插件自己的目录"追加进 `ignorePaths`，两边都排除。
 *
 * **为什么要关掉自同步**：上游 `obsFolderLister.ts` 对自己的插件目录做了特殊
 * 处理——只同步 `data.json` / `main.js` / `manifest.json` / `.gitignore` /
 * `styles.css` 五个文件，好让用户的其它设备也拿到插件。但在 NextClaw 的交付
 * 模型下这是有害的：
 *
 * - **帮不上 bootstrap**：第二台设备不先装插件就没法同步，服务端那份够不着；
 * - **会静默降级**：设备 A 从市场升到新版、设备 B 还是旧版，谁后同步谁赢，
 *   另一台的 `main.js` 被按 mtime 覆盖；
 * - **每次白传 4MB**：`main.js` 就有这么大。
 *
 * **为什么走 `ignorePaths` 而不是改 `obsFolderLister.ts`**：后者只管**本地**
 * 遍历。只在本地排除的话，服务端已有的那份会被判成"远端新建"而**每次同步都
 * 下载回来**，甚至用旧版覆盖正在运行的 `main.js`——比不改还糟。
 * 引擎规格要求：`ignorePaths` 对远端清单、本地清单、同步记录**三处**都生效，
 * 命中的路径整条退出本次同步。
 */
export const effectiveIgnorePaths = (
  ignorePaths: string[] | undefined,
  pluginId: string,
  configDir: string
): string[] => {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selfDir = `^${esc(configDir)}/plugins/${esc(pluginId)}(/|$)`;
  const base = ignorePaths ?? [];
  return base.includes(selfDir) ? base : [...base, selfDir];
};
