/**
 * 续费链接与按钮显示条件。
 *
 * 两条最要紧：链接里绝不出现密码；用户名必须 URL 编码（它是自由文本，
 * 不编码就等于把查询串的控制权交给用户填的内容）。
 */
import { strict as assert } from "assert";
import {
  NEXTCLAW_RENEW_PAGE,
  renewLink,
  shouldShowRenewButton,
} from "../../src/nextclaw/renew";
import {
  NEXTCLAW_PUBLIC_SHARE_TOKEN,
  NEXTCLAW_PUBLIC_WEBDAV_URL,
} from "../../src/nextclaw/constants";

const student = (username = "s10013", address?: string) => ({
  username,
  address:
    address ??
    `https://cloud.nextclaw.chat/remote.php/dav/files/${username}/Documents`,
  password: "绝不能出现在链接里",
});

const url = (webdav: Parameters<typeof renewLink>[0]) => {
  const link = renewLink(webdav);
  assert.equal(link.ok, true);
  return (link as { ok: true; url: string }).url;
};

describe("nextclaw/renew", () => {
  describe("链接", () => {
    it("形状与设计文档一致", () => {
      assert.equal(
        url(student()),
        "https://ai.nextclaw.chat/?customer=s10013&pay=qr"
      );
    });

    it("绝不携带密码", () => {
      const built = url(student());
      assert.ok(!built.includes("绝不能出现在链接里"));
      assert.ok(!built.toLowerCase().includes("password"));
      assert.ok(!built.includes("pass"));
    });

    it("用户名做 URL 编码，挡住查询串注入", () => {
      // 不编码的话这一串会变成第二个 customer 参数，充值对象就被换掉了
      const built = url(student("s1&customer=s99999"));
      assert.ok(built.includes("customer=s1%26customer%3Ds99999"));
      assert.equal(new URL(built).searchParams.getAll("customer").length, 1);
      assert.equal(
        new URL(built).searchParams.get("customer"),
        "s1&customer=s99999"
      );
    });

    it("中文与空格也编码", () => {
      const built = url(student("学号 1"));
      assert.ok(!built.includes(" "));
      assert.equal(new URL(built).searchParams.get("customer"), "学号 1");
    });

    it("域名是插件里的常量，不受设置影响", () => {
      // 地址改成别处时按钮本来就不显示；这里钉的是"链接的域名不从设置里取"
      const built = url({ username: "s10013" });
      assert.equal(new URL(built).host, "ai.nextclaw.chat");
      assert.equal(new URL(NEXTCLAW_RENEW_PAGE).protocol, "https:");
    });

    it("用户名两端的空白被去掉", () => {
      assert.equal(
        new URL(url(student("  s10013  "))).searchParams.get("customer"),
        "s10013"
      );
    });

    it("用户名为空时不给链接", () => {
      assert.deepEqual(renewLink({ username: "" }), {
        ok: false,
        reason: "empty-username",
      });
      assert.deepEqual(renewLink({ username: "   " }), {
        ok: false,
        reason: "empty-username",
      });
      assert.equal(renewLink(undefined).ok, false);
    });
  });

  describe("显示条件", () => {
    it("平板上的学生账号：显示", () => {
      assert.equal(shouldShowRenewButton(student(), false), true);
    });

    it("桌面端：不显示（0.1.5 起本来就不同步学生账号）", () => {
      assert.equal(shouldShowRenewButton(student(), true), false);
    });

    it("演示库用户：不显示", () => {
      // 演示库在设置里就是"没填用户名"。公开分享的 token 与占位密码是连接时
      // 注入的，从不写进设置（见 branch.ts 的 effectiveWebdavConfig）。
      assert.equal(
        shouldShowRenewButton(
          { username: "", address: NEXTCLAW_PUBLIC_WEBDAV_URL },
          false
        ),
        false
      );
    });

    it("手填了公开分享 token 当用户名：会显示，且这是可接受的", () => {
      // 这个状态正常流程里不会出现。真出现时最坏结果是多显示一个按钮，
      // 点开也只是一个填错学号的续费页——比"把付了钱的学生挡在门外"轻得多。
      assert.equal(
        shouldShowRenewButton(
          {
            username: NEXTCLAW_PUBLIC_SHARE_TOKEN,
            address: NEXTCLAW_PUBLIC_WEBDAV_URL,
          },
          false
        ),
        true
      );
    });

    it("用其他 WebDAV 服务的用户：不显示", () => {
      assert.equal(
        shouldShowRenewButton(
          { username: "someone", address: "https://dav.example.com/remote.php" },
          false
        ),
        false
      );
    });

    it("没填用户名：不显示", () => {
      assert.equal(shouldShowRenewButton({ username: "" }, false), false);
    });

    it("订阅到期、网络不通都不影响显示", () => {
      // 判据里只有本地设置，没有任何网络或状态输入——这一条靠函数签名保证：
      // 它只收 webdav 与 isDesktopApp 两个参数。
      assert.equal(shouldShowRenewButton.length, 2);
      assert.equal(shouldShowRenewButton(student(), false), true);
    });
  });
});
