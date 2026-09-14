import { strict as assert } from "assert";
import { existsSync, readFileSync, readdirSync } from "fs";
import * as path from "path";
import { PRESET_A, PRESET_B } from "../../src/nextclaw/presets";

const root = path.join(__dirname, "..", "..");
const src = (f: string) => readFileSync(path.join(root, "src", f), "utf8");
const allSrc = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(path.join(root, "src"));
  return out.join("\n");
};

describe("NextClaw：只保留 WebDAV", () => {
  it("其它网盘、端到端加密、设置导入导出、上游首次启动弹窗的代码都已删除", () => {
    for (const f of [
      "fsDropbox.ts",
      "fsOnedrive.ts",
      "fsS3.ts",
      "fsWebdis.ts",
      "fsEncrypt.ts",
      "encryptOpenSSL.ts",
      "encryptRClone.ts",
      "importExport.ts",
      "syncAlgoV3Notice.ts",
    ]) {
      assert.equal(existsSync(path.join(root, "src", f)), false, f);
    }
  });

  it("不注册任何 obsidian:// 协议处理器——那是设置导入（含凭据）与 OAuth 回调的入口", () => {
    assert.doesNotMatch(allSrc(), /registerObsidianProtocolHandler/);
  });

  it("依赖里不再有其它网盘、加密与二维码的库", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = deps.filter((d) =>
      /aws|azure|dropbox|microsoft-graph|rclone|qrcode|smithy|msal/.test(d)
    );
    assert.deepEqual(banned, []);
  });

  it("PRO 付费功能不存在——那是上游的付费服务，本插件不提供", () => {
    assert.doesNotMatch(allSrc(), /proDiv|generateProSettingsPart|below for pro/);
  });

  it("serviceType 被预设强制为 webdav（本地同步记录按它区分，不能变）", () => {
    assert.equal(PRESET_A.serviceType, "webdav");
    assert.equal(PRESET_B.serviceType, "webdav");
  });

  it("旧版本留下的其它网盘与加密设置在加载时删除", () => {
    const m = src("main.ts");
    const i = m.indexOf("const LEGACY_SETTING_KEYS = [");
    assert.ok(i > 0);
    const list = m.slice(i, m.indexOf("];", i));
    for (const k of ["s3", "dropbox", "onedrive", "webdis", "password", "encryptionMethod", "agreeToUseSyncV3"]) {
      assert.match(list, new RegExp(`"${k}"`), k);
    }
    const load = m.slice(m.indexOf("async loadSettings()"));
    assert.match(load, /for \(const key of LEGACY_SETTING_KEYS\) \{\s*delete /);
  });
});
