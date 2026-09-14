import { strict as assert } from "assert";

import type { NextclawSyncSettings } from "../src/baseTypes";
import { messyConfigToNormal, normalConfigToMessy } from "../src/configPersist";

const DEFAULT_SETTINGS: NextclawSyncSettings = {
  webdav: {
    address: "addr",
    username: "测试中文",
    password: "test 🍎 emoji",
  } as any,
  serviceType: "webdav",
  currLogLevel: "info",
  ignorePaths: ["somefoldertoignore"],
  enableStatusBarInfo: true,
};

describe("Config Persist tests", () => {
  it("should encrypt go back and forth conrrectly", async () => {
    const k = DEFAULT_SETTINGS;
    const k2 = normalConfigToMessy(k);
    const k3 = messyConfigToNormal(k2);
    assert.deepEqual(k3, k);
  });
});

describe("Config Persist: 与已保存的设置文件兼容", () => {
  // 由改写前（基于 Buffer）的实现生成，含中文、emoji 与非 ASCII 地址。
  const saved = {
    readme:
      "The file contains sensitive info, so DO NOT take screenshot of, copy, or share it to anyone! It's also generated automatically, so do not edit it manually.",
    d: "0XM6IibiwSXiEmIbpjIzhGdhBVZy9mbnlmIsIidhRmYldnI6ISZwlHVlNWa2JXZzJCL9JCZy92dg4YjfCPIzNHQwJiOiQmcvd3czFGciwiIxAznUeuptWuI6ISZtFmbyV2c1JCLiYXYk9SbvNmLQ2a5L6L5v8iOzBHd0hmI6IyczVmckRWYisnOiYXYkJWZ3Jye",
  };
  const plain = {
    webdav: {
      address: "https://例子.com/dav",
      username: "学生01",
      password: "p@ss 🍎 word",
    },
    serviceType: "webdav",
    ignorePaths: ["a"],
    n: 1,
  };

  it("能读出旧实现写入的设置", () => {
    assert.deepEqual(messyConfigToNormal(saved as any), plain);
  });

  it("写出的内容与旧实现逐字节一致", () => {
    assert.deepEqual(normalConfigToMessy(plain as any), saved);
  });
});
