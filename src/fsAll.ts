import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
  contentBinding(): { origin: string; account: string; remoteRoot: string; nativeManaged: boolean; journalToken?: string } {
    throw new Error("此远端不支持内容同步适配器");
  }
  contentEndpoint(_key: string): string { throw new Error("缺少内容写入端点"); }
  async readContent(_key: string, _expected: Entity): Promise<{ bytes: ArrayBuffer; etag: string }> {
    throw new Error("缺少带响应版本的条件读取");
  }
  async putContent(_key: string, _bytes: ArrayBuffer, _expected: string | null): Promise<{ status: number; etag?: string }> {
    throw new Error("缺少原始内容上传回执");
  }
  async deleteContent(_key: string, _expected: Entity): Promise<{ status: number }> {
    throw new Error("缺少明确完成回执的条件删除");
  }
  supportsSingleAttemptMove(): boolean { return false; }
  async moveContent(_source: string, _target: string, _etag: string): Promise<{ status: number }> {
    throw new Error("缺少受保护的远端改名适配器");
  }
  async checkContentRootParent(): Promise<void> { throw new Error("缺少根目录父路径核验"); }
  async restoreContentRoot(): Promise<{ status: number }> { throw new Error("缺少可证明作用域的根恢复适配器"); }
  abstract walk(): Promise<Entity[]>;
  abstract stat(key: string): Promise<Entity>;
  abstract mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity>;
  abstract writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity>;
  /** Expected discovery version is enforced by the adapter at mutation time. */
  async writeFileGuarded(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expected: Entity | null,
    expectedBytes?: ArrayBuffer,
    _assertCurrent?: () => void
  ): Promise<Entity> {
    throw new Error(`此存储不支持受保护写入：${key}`);
  }
  async rmGuarded(
    key: string,
    expected: Entity,
    expectedBytes?: ArrayBuffer,
    _assertCurrent?: () => void
  ): Promise<void> {
    throw new Error(`此存储不支持受保护删除：${key}`);
  }
  abstract readFile(key: string, expected?: Entity): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string): Promise<void>;
  abstract rm(key: string): Promise<void>;
}
