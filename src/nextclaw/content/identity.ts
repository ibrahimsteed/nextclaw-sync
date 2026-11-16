import type { Entity } from "../../baseTypes";
import type { FakeFs } from "../../fsAll";
import { assertVersion, equalBytes, etagHeader, SyncConflict } from "../engine/versionGuard";

export const NOTE_LIMIT = 4 * 1024 * 1024;
export const PROFILE_LIMIT = 32 * 1024 * 1024;
export type ContentStatus = "unbased" | "clean" | "content-conflict" | "migration-pending" | "merge-pending" | "deleted";
export interface ContentRecord {
  version: 1;
  scopeKey: string;
  status: ContentStatus;
  localHash?: string;
  remoteHash?: string;
  remoteEtag?: string;
  remoteFileId?: string;
  cleanBaseRef?: string;
  conflictRef?: string;
  operationRef?: string;
  acknowledgedUploadRef?: string;
}
export const isHash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
}
/** An opaque structured key, not a password-bearing URL or a path prefix. */
export function scopeKey(scope: {
  vault: string; profile: string; origin: string; account: string;
  remoteRoot: string; configDir: string; filterVersion: number;
}): string {
  const url = new URL(scope.origin);
  if ([scope.vault, scope.profile, scope.account, scope.configDir].some(x => !x.trim() || x.includes("\0")))
    throw new Error("Invalid content scope identity");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !["https:", "http:"].includes(url.protocol) ||
      !Number.isSafeInteger(scope.filterVersion) || scope.filterVersion < 1)
    throw new Error("Invalid content scope");
  for (const path of [scope.remoteRoot, scope.configDir])
    if (path.includes("\0") || path.split("/").some(x => x === "." || x === ".."))
      throw new Error("Unsafe content scope path");
  return JSON.stringify([scope.vault, scope.profile, url.origin, scope.account,
    scope.remoteRoot.normalize("NFC").replace(/\/+$/, ""),
    scope.configDir.normalize("NFC").replace(/\/+$/, ""), scope.filterVersion]);
}
export function validContentRecord(value: unknown): value is ContentRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as ContentRecord;
  return v.version === 1 && typeof v.scopeKey === "string" && v.scopeKey.length > 0 &&
    ["unbased", "clean", "content-conflict", "migration-pending", "merge-pending", "deleted"].includes(v.status) &&
    [v.localHash, v.remoteHash].every(x => x === undefined || isHash(x)) &&
    [v.remoteEtag, v.remoteFileId, v.cleanBaseRef, v.conflictRef, v.operationRef, v.acknowledgedUploadRef]
      .every(x => x === undefined || typeof x === "string" && x.length > 0);
}
export function decodeText(bytes: ArrayBuffer): string {
  // Preserve BOM: text is for merge only; the digest always covers the original bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export interface Snapshot { entity: Entity; bytes: ArrayBuffer; hash: string; }
/** No signature cache: same-size/same-time edits between reads are still rejected. */
export async function localSnapshot(fs: Pick<FakeFs, "stat" | "readFile">, path: string, expected: Entity,
  assertOwner: () => void, maxBytes = NOTE_LIMIT): Promise<Snapshot> {
  expected = { ...expected };
  assertOwner(); await assertVersion(fs, path, expected); assertOwner();
  if ((expected.size ?? expected.sizeRaw) > maxBytes) throw new Error("content-limit-pending");
  const bytes = (await fs.readFile(path)).slice(0); assertOwner();
  if (bytes.byteLength > maxBytes) throw new Error("content-limit-pending");
  await assertVersion(fs, path, expected); assertOwner();
  const second = await fs.readFile(path); assertOwner();
  if (!equalBytes(bytes, second)) throw new SyncConflict("本地内容在快照读取期间变化");
  await assertVersion(fs, path, expected); assertOwner();
  const hash = await hashBytes(bytes); assertOwner();
  return { entity: expected, bytes, hash };
}
/** Conditional GET and post-read version check. This never settles an unknown mutation. */
export async function remoteSnapshot(fs: Pick<FakeFs, "stat" | "readFile">, path: string, expected: Entity,
  assertOwner: () => void, maxBytes = NOTE_LIMIT): Promise<Snapshot> {
  expected = { ...expected };
  assertOwner(); etagHeader(expected);
  if ((expected.size ?? expected.sizeRaw) > maxBytes) throw new Error("content-limit-pending");
  const bytes = (await fs.readFile(path, expected)).slice(0); assertOwner();
  if (bytes.byteLength > maxBytes) throw new Error("content-limit-pending");
  await assertVersion(fs, path, expected); assertOwner();
  const hash = await hashBytes(bytes); assertOwner();
  if (expected.remoteChecksum && expected.remoteChecksum !== hash)
    throw new SyncConflict("远端校验和与实际字节不一致");
  return { entity: expected, bytes, hash };
}
/** Only SHA256 is a content identity; file IDs remain strings scoped to an account/root. */
export function davContentProperties(props: unknown): { remoteChecksum?: string; remoteFileId?: string } {
  if (!props || typeof props !== "object") return {};
  const p = props as Record<string, unknown>;
  const parsedId = p.fileid ?? p["oc:fileid"];
  // The DAV XML parser converts ordinary decimal IDs to numbers. Never accept rounded IDs.
  const id = typeof parsedId === "number" && Number.isSafeInteger(parsedId) && parsedId >= 0
    ? String(parsedId) : parsedId;
  const raw = p.checksums ?? p["oc:checksums"];
  const entries = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).checksum : raw;
  const sums = (Array.isArray(entries) ? entries : [entries])
    .filter((x): x is string => typeof x === "string")
    .flatMap(x => x.split(/\s+/)).filter(x => /^SHA256:[a-f0-9]{64}$/i.test(x))
    .map(x => x.slice(7).toLowerCase());
  const unique = [...new Set(sums)];
  return { ...(typeof id === "string" && /^\d+$/.test(id) ? { remoteFileId: id } : {}),
    ...(unique.length === 1 ? { remoteChecksum: unique[0] } : {}) };
}
