import { strict as assert } from "assert";
import en from "../../src/langs/en.json";
import { relativeTimeText } from "../../src/statusBarTime";

const t = (k: string, vars?: Record<string, string | number>) =>
  (en as Record<string, string>)[k].replace("{{time}}", `${vars?.time}`);

describe("NextClaw：状态栏的同步时间文字", () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  it("数量为 1 时用单数，大于 1 时用复数", () => {
    assert.equal(relativeTimeText(1 * M + 5 * S, t), "1 minute ago");
    assert.equal(relativeTimeText(2 * M, t), "2 minutes ago");
    assert.equal(relativeTimeText(1 * H, t), "1 hour ago");
    assert.equal(relativeTimeText(3 * H, t), "3 hours ago");
    assert.equal(relativeTimeText(1 * D, t), "1 day ago");
    assert.equal(relativeTimeText(8 * D, t), "1 week ago");
    assert.equal(relativeTimeText(31 * D, t), "1 month ago");
    assert.equal(relativeTimeText(400 * D, t), "1 year ago");
    assert.equal(relativeTimeText(800 * D, t), "2 years ago");
  });
  it("不到一分钟：30 秒以内是 just now，之后是 less than a minute ago", () => {
    assert.equal(relativeTimeText(10 * S, t), "just now");
    assert.equal(relativeTimeText(45 * S, t), "less than a minute ago");
  });
});
