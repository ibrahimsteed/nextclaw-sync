import type { NextclawSyncSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsWebdav } from "./fsWebdav";

import { effectiveWebdavConfig } from "./nextclaw/branch";

export function getClient(
  settings: NextclawSyncSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<void>
): FakeFs {
  // NextClaw：A 分支在这里注入公开分享的 token 与占位密码。
  // 它们**不写进设置**——写进去 detectBranch 就永远判成 B。
  return new FakeFsWebdav(
    effectiveWebdavConfig(settings.webdav),
    vaultName,
    saveUpdatedConfigFunc
  );
}
