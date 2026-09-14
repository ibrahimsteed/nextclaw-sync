/**
 * 用户名变化时该发生什么——**提成纯函数**，以便真正被测到。
 *
 * 写在 `settings.ts` 的 onChange 里只能靠"读源码断言"来验，而读源码验的是
 * **位置**，拦不住"分支被禁用"这类改动（例如给条件加个 `false &&`，位置没变，
 * 断言照样通过）。逻辑放在这里，测试就能验真实行为。
 */
import { detectBranch, accountAddressFor, isManagedAddress } from "./branch";
import { applyBranchPreset, type PresetSettings } from "./presets";

export interface UsernameChangeResult {
  /** 分支变了吗——变了才需要刷新控件的锁定状态。 */
  branchChanged: boolean;
  /** 是否刚从 A 切到 B（要打切换标记）。 */
  switchedAtoB: boolean;
  /** 地址变了吗——变了才需要同步到输入框。 */
  addressChanged: boolean;
  /** 变化后的地址。 */
  address: string;
}

export const applyUsernameChange = (
  settings: PresetSettings,
  rawValue: string,
  isMobile = false
): UsernameChangeResult => {
  const webdav = (settings.webdav ??= {});
  const branchBefore = detectBranch(webdav);
  const addressBefore = webdav.address ?? "";

  webdav.username = rawValue.trim();

  const branchAfter = detectBranch(webdav);
  const branchChanged = branchAfter !== branchBefore;

  if (branchChanged) {
    applyBranchPreset(settings, isMobile);
  }

  // 地址跟着用户名**每一次**变化重算，不能只在切换那一次算——
  // 否则会被定死成用户名第一个字符生成的那个（如 .../files/s/Documents）。
  // isManagedAddress 保证用户自己改过的地址不会被覆盖。
  if (branchAfter === "B" && isManagedAddress(webdav.address)) {
    webdav.address = accountAddressFor(webdav.username);
  }

  // 还没真正切换就又清空了用户名：取消待执行的切换。
  // 否则下一次同步演示库时仍会执行 A→B 清理，把库里的内容移进 .trash。
  if (branchChanged && branchAfter === "A") {
    settings.nextclawPendingSwitchToB = false;
  }

  const switchedAtoB = branchChanged && branchBefore === "A";
  if (switchedAtoB) {
    // 只打标记。真正的删除与清记录推迟到下次同步开始前——
    // 此刻用户才刚敲下用户名的第一个字符。
    settings.nextclawPendingSwitchToB = true;
  }

  return {
    branchChanged,
    switchedAtoB,
    addressChanged: (webdav.address ?? "") !== addressBefore,
    address: webdav.address ?? "",
  };
};
