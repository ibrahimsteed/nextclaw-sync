import { strict as assert } from "assert";
import { BranchLocks } from "../../src/nextclaw/branchUi";
import { NEXTCLAW_PUBLIC_WEBDAV_URL } from "../../src/nextclaw/constants";

/** 最小的假控件，只记录被设成了什么。 */
const fakeText = () => {
  const st = { disabled: undefined as boolean | undefined, value: "" };
  return {
    st,
    setDisabled(v: boolean) {
      st.disabled = v;
      return this;
    },
    setValue(v: string) {
      st.value = v;
      return this;
    },
  };
};

describe("NextClaw 阶段 2：设置界面的分支锁定", () => {
  it("A 分支：地址被置灰，并强制回落到公开分享地址", () => {
    const webdav: any = { username: "", address: "https://elsewhere/" };
    const locks = new BranchLocks(webdav);
    const addr = fakeText();
    locks.bindAddress(addr);
    locks.refresh();

    assert.equal(addr.st.disabled, true);
    assert.equal(addr.st.value, NEXTCLAW_PUBLIC_WEBDAV_URL);
  });

  it("回落同时写回设置，而不只是改显示", () => {
    // 只改显示的话，界面上看到的地址和实际连接的地址会不一致。
    const webdav: any = { username: "", address: "https://elsewhere/" };
    const locks = new BranchLocks(webdav);
    locks.bindAddress(fakeText());
    locks.refresh();
    assert.equal(webdav.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
  });

  it("B 分支：地址解锁，且不被改写", () => {
    const webdav: any = { username: "student01", address: "https://my.own/dav" };
    const locks = new BranchLocks(webdav);
    const addr = fakeText();
    locks.bindAddress(addr);
    locks.refresh();

    assert.equal(addr.st.disabled, false);
    assert.equal(webdav.address, "https://my.own/dav");
  });

  it("受控控件随分支切换", () => {
    const webdav: any = { username: "", address: "" };
    const locks = new BranchLocks(webdav);
    const a = fakeText();
    const b = fakeText();
    locks.lockInA(a);
    locks.lockInA(b);

    locks.refresh();
    assert.equal(a.st.disabled, true);
    assert.equal(b.st.disabled, true);

    webdav.username = "student01"; // 用户填了用户名
    locks.refresh();
    assert.equal(a.st.disabled, false);
    assert.equal(b.st.disabled, false);
  });

  it("没绑定地址栏时不报错", () => {
    const locks = new BranchLocks({ username: "" } as any);
    locks.refresh(); // 不应抛
  });
});
