/**
 * 设置界面的分支锁定。
 *
 * A 分支下若干控件不可编辑。做成收集器而不是在 `settings.ts` 里
 * 逐个写 if，是为了把上游文件的改动压到最小——将来合并上游冲突面越小越好。
 *
 * **不重新渲染整个面板**：分支切换发生在用户键入第一个字符时，
 * 那一刻 `display()` 会抢走焦点、打断输入。这里直接切控件的 disabled 状态。
 */
import { detectBranch, isManagedAddress } from "./branch";
import { NEXTCLAW_PUBLIC_WEBDAV_URL } from "./constants";
import type { WebdavConfig } from "../baseTypes";

type Disableable = { setDisabled(v: boolean): unknown };
type Valued = Disableable & { setValue(v: string): unknown };

export class BranchLocks {
  private addressText?: Valued;
  private lockedInA: Disableable[] = [];
  private lockedWhenNextclawAddress: Disableable[] = [];

  constructor(private readonly webdav: Partial<WebdavConfig>) {}

  /** 地址栏：A 分支下强制回落到公开分享地址并置灰。 */
  bindAddress(text: Valued): void {
    this.addressText = text;
  }

  /** A 分支下应当置灰的控件。 */
  lockInA(comp: Disableable): void {
    this.lockedInA.push(comp);
  }

  /**
   * 服务器地址是 NextClaw 地址（演示库公开分享、学生账号模板地址）时应当置灰的控件。
   *
   * 用于远端目录：NextClaw 的远端目录是固定值，改了会让同步记录对应到别的目录。
   * 只有把服务器地址改成其他 WebDAV 服务后才可编辑。
   */
  lockWhenNextclawAddress(comp: Disableable): void {
    this.lockedWhenNextclawAddress.push(comp);
  }

  /** 地址被程序改过之后同步到输入框——只改设置不改显示会让两者对不上。 */
  showAddress(value: string): void {
    this.addressText?.setValue(value);
  }

  refresh(): void {
    const isA = detectBranch(this.webdav) === "A";
    if (this.addressText !== undefined && isA) {
      // 回落**同时写回设置**，不只是显示——否则界面与实际连接的地址会不一致。
      this.webdav.address = NEXTCLAW_PUBLIC_WEBDAV_URL;
      this.addressText.setValue(NEXTCLAW_PUBLIC_WEBDAV_URL);
    }
    this.addressText?.setDisabled(isA);
    for (const c of this.lockedInA) {
      c.setDisabled(isA);
    }
    const nextclawAddress = isA || isManagedAddress(this.webdav.address);
    for (const c of this.lockedWhenNextclawAddress) {
      c.setDisabled(nextclawAddress);
    }
  }
}
