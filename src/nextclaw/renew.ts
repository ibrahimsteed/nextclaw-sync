/**
 * 续费入口（0.1.7）。
 *
 * 设计文档第九节：**只加一个按钮**，不显示日期、不显示状态。
 *
 * ## 为什么插件不查订阅状态
 *
 * 方案 D 的全部好处就在这里：插件**不发任何订阅相关的请求，不缓存、不轮询**。
 * 由此 README 的网络说明不用改，社区市场复核也没有新的网络行为要解释。
 * 到期日和订阅状态由两条别的通道送达——写进学生库的提醒笔记，以及支付页本身。
 *
 * ## 为什么显示条件只看本地设置
 *
 * 按网络或订阅状态决定显不显示，会在**最需要续费的时候**（服务已停、网络不通）
 * 恰好把按钮藏起来。所以判据只有一条：这是不是 NextClaw 学生账号。
 * 判错的最坏结果是多显示一个按钮，而不是把付了钱的学生挡在门外。
 */
import { isNextclawStudentAccount } from "./accountPolicy";

/**
 * 续费页地址。**写死在插件里的常量**，不接受任何外部下发的链接——
 * 否则服务端一旦被冒充，就能把学生引到任意页面去付款。
 */
export const NEXTCLAW_RENEW_PAGE = "https://ai.nextclaw.chat/";

/**
 * 固定二维码模式。页面在没有这个参数时行为相同，写明只是把意图摆出来：
 * 不检测平板上装没装微信、不按 User-Agent 改变行为。
 */
const PAY_MODE = "qr";

export type RenewLink =
  | { ok: true; url: string }
  | { ok: false; reason: "empty-username" };

/**
 * 拼续费链接。
 *
 * 两条不能松：
 * - 用户名必须 **URL 编码**。它是用户可填的自由文本，不编码就等于把查询串
 *   的控制权交出去（`s1&customer=别人` 这种）。
 * - 链接里**绝不携带密码**。这个函数只取 `username`，连 `password` 都不读。
 */
export const renewLink = (
  webdav: { username?: string } | undefined
): RenewLink => {
  const username = (webdav?.username ?? "").trim();
  if (username === "") {
    // 正常情况下用户名为空时按钮根本不显示（那时是 A 分支）。这一条挡的是
    // "设置页开着，用户把用户名删空又点了按钮"。
    return { ok: false, reason: "empty-username" };
  }
  const url = new URL(NEXTCLAW_RENEW_PAGE);
  url.searchParams.set("customer", username);
  url.searchParams.set("pay", PAY_MODE);
  return { ok: true, url: url.toString() };
};

/**
 * 要不要显示续费按钮。
 *
 * - 演示库用户（A 分支）、用其他 WebDAV 服务的用户：同一判据排除。
 * - 桌面端：自 0.1.5 起本来就不同步学生账号，这里同样不显示。
 */
export const shouldShowRenewButton = (
  webdav: { username?: string; address?: string } | undefined,
  isDesktopApp: boolean
): boolean => !isDesktopApp && isNextclawStudentAccount(webdav);
