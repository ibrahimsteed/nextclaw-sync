import type { TransItemType, TransVars } from "./i18n";

type Translate = (key: TransItemType, vars?: TransVars) => string;

const UNITS: [ms: number, one: TransItemType, many: TransItemType][] = [
  [31556952000, "statusbar_time_year", "statusbar_time_years"],
  [2629746000, "statusbar_time_month", "statusbar_time_months"],
  [604800000, "statusbar_time_week", "statusbar_time_weeks"],
  [86400000, "statusbar_time_day", "statusbar_time_days"],
  [3600000, "statusbar_time_hour", "statusbar_time_hours"],
  [60000, "statusbar_time_minute", "statusbar_time_minutes"],
];

/** 状态栏里"多久以前同步"的文字；数量为 1 时用单数说法。 */
export const relativeTimeText = (deltaMs: number, t: Translate): string => {
  for (const [ms, one, many] of UNITS) {
    const n = Math.floor(deltaMs / ms);
    if (n > 0) {
      return n === 1 ? t(one) : t(many, { time: n });
    }
  }
  return deltaMs > 30000 ? t("statusbar_time_lessminute") : t("statusbar_time_now");
};
