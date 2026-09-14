/**
 * NextClaw Sync 专属常量。
 *
 * 全部 NextClaw 特有的值都收在这个文件里，上游文件只做最小挂钩——
 * 将来合并上游改动时，冲突面越小越好。
 */

/** A 分支：欢迎库的公开链接分享（只读演示库）。 */
export const NEXTCLAW_PUBLIC_WEBDAV_URL =
  "https://cloud.nextclaw.chat/public.php/webdav";

/**
 * 公开链接分享的 token，充当 WebDAV 用户名。
 *
 * 这**不是凭据**：它是一个公开链接，服务端对 PUT / DELETE / MKCOL / MOVE
 * 等写操作一律返回 403。写进源码是有意为之。
 *
 * 轮换时注意：换 token 会让所有已安装的旧版本插件同时失效，
 * 必须与发版绑定并保留双 token 并存期。
 */
export const NEXTCLAW_PUBLIC_SHARE_TOKEN = "H4KnnP9mdFfEbLY";

/**
 * 占位密码。
 *
 * `src/fsWebdav.ts` 只在 `username !== "" && password !== ""` 时才发
 * Basic 认证头；密码为空时**根本不发头**，对 `/public.php/webdav` 就是 401。
 * 而 Nextcloud 对无密码的公开分享**忽略密码内容**，任意非空值都返回 207。
 * 所以填个占位符即可，不必改上游代码。
 */
// 取一个自解释的值：用户若在 data.json 里看到它，能一眼明白这不是真密码。
export const NEXTCLAW_PUBLIC_SHARE_PASSWORD = "public-share-no-password";

/**
 * B 分支：用户自己账号的地址模板，`{username}` 在用户填入用户名后替换。
 * 这是**可编辑的初始值**，不是隐藏的固定值——用户可改为任意兼容 WebDAV 的服务。
 */
export const NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE =
  "https://cloud.nextclaw.chat/remote.php/dav/files/{username}/Documents";

export const NEXTCLAW_USERNAME_PLACEHOLDER = "{username}";

/**
 * 远端基文件夹。
 *
 * 两个分支取值相同，因此没有特例——A 分支的公开分享指向欢迎库的**上一级**
 * （`admin/Welcome/`），所以这里同样是 `ObsidianVault_Math`。
 *
 * **不能留空**：`src/fsWebdav.ts` 里
 * `remoteBaseDir || vaultName || ""` 会回落成用户的本地 vault 名，
 * 而"让用户本地库名随便起"正是这个字段存在的理由。
 */
export const NEXTCLAW_REMOTE_BASE_DIR = "ObsidianVault_Math";

/** 覆盖到 `DEFAULT_SETTINGS.webdav` 上的预填值。 */
export const NEXTCLAW_WEBDAV_DEFAULTS = {
  address: NEXTCLAW_PUBLIC_WEBDAV_URL,
  username: "",
  password: "",
  remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR,
} as const;
