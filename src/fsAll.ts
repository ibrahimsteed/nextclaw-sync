import type { Entity } from "./baseTypes";

export abstract class FakeFs {
  abstract kind: string;
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
    expectedBytes?: ArrayBuffer
  ): Promise<Entity> {
    throw new Error(`此存储不支持受保护写入：${key}`);
  }
  async rmGuarded(
    key: string,
    expected: Entity,
    expectedBytes?: ArrayBuffer
  ): Promise<void> {
    throw new Error(`此存储不支持受保护删除：${key}`);
  }
  abstract readFile(key: string, expected?: Entity): Promise<ArrayBuffer>;
  abstract rename(key1: string, key2: string): Promise<void>;
  abstract rm(key: string): Promise<void>;
}
