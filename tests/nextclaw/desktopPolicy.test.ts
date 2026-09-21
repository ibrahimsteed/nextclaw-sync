import { strict as assert } from "assert";
import {
  NEXTCLAW_HOST,
  isNextclawHost,
  isStudentAccountOnDesktop,
} from "../../src/nextclaw/desktopPolicy";
import { accountAddressFor } from "../../src/nextclaw/branch";
import { NEXTCLAW_PUBLIC_WEBDAV_URL } from "../../src/nextclaw/constants";

const student = (address: string) => ({ username: "s10012", address });

describe("NextClaw：桌面端不同步学生账号", () => {
  it("主机名从账号地址模板推出", () => {
    assert.equal(NEXTCLAW_HOST, "cloud.nextclaw.chat");
  });

  it("桌面端 + 学生账号 → 拦下", () => {
    assert.equal(
      isStudentAccountOnDesktop(student(accountAddressFor("s10012")), true),
      true
    );
  });

  it("移动端 + 学生账号 → 放行", () => {
    assert.equal(
      isStudentAccountOnDesktop(student(accountAddressFor("s10012")), false),
      false
    );
  });

  it("桌面端 + 演示库（没填用户名）→ 放行", () => {
    assert.equal(
      isStudentAccountOnDesktop(
        { username: "", address: NEXTCLAW_PUBLIC_WEBDAV_URL },
        true
      ),
      false
    );
    // 只有空白也算没填。
    assert.equal(
      isStudentAccountOnDesktop(
        { username: "   ", address: NEXTCLAW_PUBLIC_WEBDAV_URL },
        true
      ),
      false
    );
  });

  it("桌面端 + 其他 WebDAV 服务 → 放行", () => {
    for (const a of [
      "https://dav.example.com/remote.php/dav/files/me",
      "https://nextclaw.chat.example.com/dav", // 只是名字里含 nextclaw.chat
      "https://evil-cloud.nextclaw.chat.example/dav",
      "http://192.168.1.10/webdav",
    ]) {
      assert.equal(isStudentAccountOnDesktop(student(a), true), false, a);
    }
  });

  it("在折叠区块里改地址绕不过去：按主机名判断", () => {
    for (const a of [
      "https://cloud.nextclaw.chat/remote.php/dav/files/s10012/Documents/",
      "https://cloud.nextclaw.chat/remote.php/webdav/",
      "https://cloud.nextclaw.chat/remote.php/dav/files/s10012",
      "https://CLOUD.NextClaw.Chat/remote.php/dav/files/s10012/Documents",
      "https://cloud.nextclaw.chat./remote.php/dav/files/s10012/Documents",
      "https://cloud.nextclaw.chat:443/remote.php/dav/files/s10012/Documents",
      "http://cloud.nextclaw.chat/remote.php/dav/files/s10012/Documents",
      "  https://cloud.nextclaw.chat/remote.php/dav/files/s10012/Documents  ",
      NEXTCLAW_PUBLIC_WEBDAV_URL, // 填了用户名却指着公开分享
    ]) {
      assert.equal(isStudentAccountOnDesktop(student(a), true), true, a);
    }
  });

  it("地址为空或还在填写中也拦：B 分支的地址由用户名自动生成", () => {
    assert.equal(isStudentAccountOnDesktop(student(""), true), true);
    assert.equal(
      isStudentAccountOnDesktop({ username: "s10012" }, true),
      true
    );
  });

  it("地址不是合法 URL 时不抛", () => {
    assert.equal(isNextclawHost("not a url"), false);
    assert.equal(isNextclawHost(undefined), false);
    assert.equal(isNextclawHost(""), false);
  });
});
