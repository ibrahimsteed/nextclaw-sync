import type { Entity } from "../../baseTypes";
import type { FakeFs } from "../../fsAll";

export class SyncConflict extends Error {
  constructor(message = "文件在扫描后发生变化，已停止旧计划") {
    super(message);
  }
}
export const equalBytes = (a: ArrayBuffer, b: ArrayBuffer) => {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
};
export const sameVersion = (a: Entity, b: Entity) =>
  (a.size ?? a.sizeRaw) === (b.size ?? b.sizeRaw) &&
  (a.mtimeSvr ?? a.mtimeCli) === (b.mtimeSvr ?? b.mtimeCli) &&
  (!a.etag || a.etag === b.etag);
export async function assertVersion(
  fs: FakeFs,
  key: string,
  expected: Entity | null
) {
  let actual: Entity | null;
  try {
    actual = await fs.stat(key);
  } catch (e) {
    const err = e as { status?: number; code?: string };
    if (err.status !== 404 && err.code !== "ENOENT") throw e;
    actual = null;
  }
  if (expected ? !actual || !sameVersion(expected, actual) : actual)
    throw new SyncConflict();
}
/** Reject weak/invalid validators rather than silently dropping the condition. */
export function etagHeader(entity: Entity) {
  const value = entity.etag;
  if (!value || value.startsWith("W/") || /[\r\n]/.test(value))
    throw new SyncConflict("服务器没有提供强 ETag，拒绝无条件覆盖或删除");
  return value.startsWith('"') ? value : `"${value}"`;
}
