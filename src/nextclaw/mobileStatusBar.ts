/**
 * 移动端状态条的两个判断：抬多高、什么时候显示。
 *
 * Obsidian 官方在移动端把整条状态栏 `display: none`，因为屏幕右下角通常是别人的
 * 按钮（例如 Copilot 输入框的「发送」）。我们为了显示同步状态把它打开，就有义务
 * 尽量不占着那个角落：同步成功后只显示一小会儿，失败和从未同步则常驻。
 */

/** 同步成功后状态条继续显示的时长。 */
export const SUCCESS_VISIBLE_MS = 6000;

/**
 * 抬高量 = 底部各条（导航栏 / 键盘上方的工具栏）中**可见者**的最大高度。
 *
 * 取最大值而不是求和：两者不会同时占着屏幕底部，键盘弹出时工具栏取代导航栏。
 * 高度为 0 表示该条不存在或已隐藏，必须算作 0——写死上一次量到的值会让状态条
 * 在导航栏消失后仍然悬空，正好落在别人的按钮上。
 */
export const liftHeight = (heights: readonly number[]): number => {
  // 逐个比较而不是 Math.max(...heights, 0)：后者遇到 NaN 会整体变成 NaN，
  // 写进 CSS 变量就是 `NaNpx`，浏览器丢弃该声明，抬高量静默失效。
  let max = 0;
  for (const h of heights) {
    if (h > max) {
      max = h;
    }
  }
  return max;
};

export type MobileStatusBarState = {
  /** 正在同步。 */
  syncing: boolean;
  /** 有过同步记录（成功或失败）。 */
  hasTimestamp: boolean;
  /** 最后一次是成功。`hasTimestamp` 为 false 时无意义。 */
  isSuccess: boolean;
  /** 距最后一次同步的毫秒数。`hasTimestamp` 为 false 时无意义。 */
  msSinceLastSync: number;
};

/**
 * 只有"同步成功且已经过去一会儿"才隐藏，其余一律显示：
 * 正在同步、同步失败、从未同步，都是学生需要看见的状态。
 */
export const shouldShowMobileStatusBar = (
  state: MobileStatusBarState,
  successVisibleMs: number = SUCCESS_VISIBLE_MS
): boolean => {
  if (state.syncing) {
    return true;
  }
  if (!state.hasTimestamp || !state.isSuccess) {
    return true;
  }
  return state.msSinceLastSync < successVisibleMs;
};
