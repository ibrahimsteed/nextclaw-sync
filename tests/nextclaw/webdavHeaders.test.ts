import { strict as assert } from "assert";
import { headerValueToText } from "../../src/misc";

describe("NextClaw：桌面端响应头可能是数组", () => {
  it("数组按 HTTP 惯例用逗号拼接", () => {
    // 桌面端 Electron 对重复的响应头返回数组：Nextcloud 一次发 4 个 set-cookie，
    // 直接丢给 onlyLatin1 会抛 "charCodeAt is not a function"，桌面端同步全废。
    assert.equal(headerValueToText(["a=1; path=/", "b=2; path=/"]), "a=1; path=/, b=2; path=/");
    assert.equal(headerValueToText([]), "");
    assert.equal(headerValueToText(["only"]), "only");
  });
  it("字符串原样返回", () => {
    assert.equal(headerValueToText("text/xml; charset=utf-8"), "text/xml; charset=utf-8");
    assert.equal(headerValueToText(""), "");
  });
  it("其它类型也转成字符串，不抛", () => {
    assert.equal(headerValueToText(123), "123");
    assert.equal(headerValueToText(undefined), "undefined");
    assert.equal(headerValueToText(null), "null");
  });
  it("返回值一定有 charCodeAt——这正是原先炸掉的地方", () => {
    for (const v of [["a", "b"], "s", 1, null, undefined, []]) {
      assert.equal(typeof headerValueToText(v).charCodeAt, "function");
    }
  });
});
