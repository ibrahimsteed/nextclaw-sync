/**
 * NextClaw 学生账号的两条准入规则：桌面端不同步、没填密码不同步。
 *
 * 两条都只针对 NextClaw 学生账号（B 分支 + 我们的服务器），
 * 演示库和其他 WebDAV 服务一概不受影响。
 *
 * ## 一、桌面端不同步学生账号
 *
 * 学生库是付费内容，只交付到 iPad 和 Android 平板。桌面端（Windows / macOS /
 * Linux 的 Obsidian）仍可同步演示库和其他 WebDAV 服务——演示库本来就公开，
 * 其他 WebDAV 与我们的内容无关。
 *
 * **这不是安全边界。** 学生手里的应用密码在任何 WebDAV 客户端里都能用
 * （访达「连接服务器」、Windows 映射网络驱动器、rclone……），插件这一层
 * 只是堵掉最顺手的那条路。真正的限制要在服务端做。
 */
import { NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE } from "./constants";
import { detectBranch, isManagedAddress } from "./branch";

/** NextClaw 服务器的主机名，从账号地址模板推出，避免两处各写一份。 */
export const NEXTCLAW_HOST = new URL(
  NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE
).hostname.toLowerCase();

/**
 * 地址是否指向 NextClaw 服务器。
 *
 * 按**主机名**判断而不是按整串地址：否则在折叠区块里把地址改一个字符
 * （补个斜杠、换个路径、主机名改大写）就绕过去了。
 */
export const isNextclawHost = (address: string | undefined): boolean => {
  try {
    const host = new URL((address ?? "").trim()).hostname
      .toLowerCase()
      .replace(/\.$/, ""); // 末尾的点是合法的绝对域名写法，指向同一台主机
    return host === NEXTCLAW_HOST;
  } catch {
    return false;
  }
};

/**
 * 当前设置是不是 **NextClaw 学生账号**：填了用户名（B 分支），且地址指向我们的服务器。
 *
 * 地址为空或仍是我们生成的形状时也算：B 分支的地址由用户名自动填写，
 * 空地址只会出现在填写过程中，不能成为漏网的缝。
 */
export const isNextclawStudentAccount = (
  webdav: { username?: string; address?: string } | undefined
): boolean => {
  // 守卫函数不能抛异常：配置还没初始化时一律放行，由后面的流程去报错。
  const w = webdav ?? {};
  if (detectBranch(w) !== "B") {
    return false;
  }
  return isNextclawHost(w.address) || isManagedAddress(w.address);
};

/**
 * 学生账号 + 运行在桌面端。
 *
 * `isDesktopApp` 必须取 `Platform.isDesktopApp`（运行环境是 Electron），
 * **不能**用 `!Platform.isMobile`——后者只是界面模式，桌面版执行
 * `app.emulateMobile(true)` 就能切成移动界面。
 */
export const isStudentAccountOnDesktop = (
  webdav: { username?: string; address?: string } | undefined,
  isDesktopApp: boolean
): boolean => isDesktopApp && isNextclawStudentAccount(webdav);

/**
 * ## 二、学生账号没填密码时不同步
 *
 * 分支判据是**用户名**（见 `branch.ts`：若要求用户名和密码都非空，用户填完
 * 用户名还没填密码的那段时间会卡在 A 分支、控件锁着，他根本没机会填密码）。
 * 代价是：只填用户名、还没填密码的这段时间里，插件已经是 B 分支了，而 B 分支
 * 的预设会打开启动同步、每 10 分钟同步、保存后同步——**下一次自动同步就会执行
 * A→B 切换，把演示库内容移进 `.trash`，然后因为没有密码而同步失败**。
 * 2026-09-24 在 Android 模拟器上用 0.1.5 实测确认过这个后果。
 *
 * 所以：学生账号在密码为空时整体不同步，也就不会切换、不会动任何文件。
 *
 * 只挡 NextClaw 学生账号，不挡其他 WebDAV 服务——后者理论上存在"匿名可写"的
 * 服务器，用户名随便填、密码留空是合法配置，不该被我们拦下。
 */
export const needsPasswordBeforeSync = (
  webdav: { username?: string; address?: string; password?: string } | undefined
): boolean =>
  isNextclawStudentAccount(webdav) && (webdav?.password ?? "") === "";
