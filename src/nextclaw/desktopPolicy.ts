/**
 * 桌面端不同步 NextClaw 学生账号。
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
 * 当前设置是否为 NextClaw 学生账号，且运行在桌面端。
 *
 * `isDesktopApp` 必须取 `Platform.isDesktopApp`（运行环境是 Electron），
 * **不能**用 `!Platform.isMobile`——后者只是界面模式，桌面版执行
 * `app.emulateMobile(true)` 就能切成移动界面。
 *
 * 地址为空或仍是我们生成的形状时也算学生账号：B 分支的地址由用户名自动填写，
 * 空地址只会出现在填写过程中，不能成为漏网的缝。
 */
export const isStudentAccountOnDesktop = (
  webdav: { username?: string; address?: string },
  isDesktopApp: boolean
): boolean => {
  if (!isDesktopApp || detectBranch(webdav) !== "B") {
    return false;
  }
  return isNextclawHost(webdav.address) || isManagedAddress(webdav.address);
};
