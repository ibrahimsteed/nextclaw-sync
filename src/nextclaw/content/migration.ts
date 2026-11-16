import { decodeRecord } from "../engine/model";
import { validContentRecord, type ContentRecord } from "./identity";
import { markerState, wholeDocumentMarkers } from "./markers";
import { equalBytes } from "../engine/versionGuard";
import { ContentStore, type BodyObject } from "./store";

export interface ConflictRegistration {
  version: 1; id: string; scope: string; path: string;
  format: "whole-document-v1";
  markerRef: string; localInputRef: string; remoteInputRef: string;
  /** Written only after both marker copies were confirmed; never inferred from current GET. */
  confirmedMarkerHash: string; remoteEtag: string;
}
export interface ContentHistory {
  identity: "new" | "legacy" | "content";
  content?: ContentRecord;
  base?: BodyObject;
  acknowledged?: BodyObject;
  conflict?: { registration: ConflictRegistration; marker: BodyObject };
  pendingLocalUpload: boolean;
}
const strong = (s: unknown): s is string => typeof s === "string" && s.length > 0 && !Array.from(s).some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) && !/^W\//i.test(s);
export { strong as strongEtag };
/** Read-only loader. Missing/corrupt/unsupported content is never retried as legacy. */
export async function loadContentHistory(input: {
  rawRecord?: unknown; scope: string; path: string; store: ContentStore;
  assertOwner: () => void;
  readConflict?(ref: string): Promise<unknown>;
}): Promise<ContentHistory> {
  const { rawRecord, scope, path, store, assertOwner } = input;
  assertOwner();
  if (store.scope !== scope) throw new Error("Content store scope mismatch");
  if (rawRecord === undefined) return { identity: "new", pendingLocalUpload: false };
  const record = decodeRecord(rawRecord);
  if (!record || record.key !== path || record.isFolder) throw new Error("Invalid file identity");
  const pendingLocalUpload = record.pendingLocalUpload === true;
  if (record.content === undefined) return { identity: "legacy", pendingLocalUpload };
  if (!validContentRecord(record.content)) throw new Error("Unsupported or corrupt content capability");
  // Snapshot references before any await: caller mutation cannot retarget a lookup.
  const content = { ...record.content };
  if (content.scopeKey !== scope) throw new Error("Content identity scope mismatch");
  const history: ContentHistory = { identity: "content", content, pendingLocalUpload };
  if (content.cleanBaseRef) {
    const base = await store.read(content.cleanBaseRef, path); assertOwner();
    if (base.kind !== "clean-base" || markerState(base.bytes) === "roles" || markerState(base.bytes) === "ambiguous")
      throw new Error("Invalid common base");
    history.base = base;
  }
  if (content.acknowledgedUploadRef) {
    if (!pendingLocalUpload) throw new Error("Acknowledged upload has no pending local edit");
    const acknowledged = await store.read(content.acknowledgedUploadRef, path); assertOwner();
    if (acknowledged.kind !== "merge-input" || acknowledged.hash !== content.remoteHash)
      throw new Error("Invalid acknowledged upload snapshot");
    history.acknowledged = acknowledged;
  }
  if (content.status === "clean" && !history.base) throw new Error("Clean identity has no verified base");
  if (content.conflictRef) {
    const raw = await input.readConflict?.(content.conflictRef); assertOwner();
    const c = raw as ConflictRegistration | undefined;
    if (!c || c.version !== 1 || c.id !== content.conflictRef || c.scope !== scope || c.path !== path ||
      c.format !== "whole-document-v1" || typeof c.markerRef !== "string" ||
      typeof c.localInputRef !== "string" || typeof c.remoteInputRef !== "string" || !strong(c.remoteEtag)) throw new Error("Invalid conflict registration");
    const registration = { ...c };
    const marker = await store.read(registration.markerRef, path); assertOwner();
    const local = await store.read(registration.localInputRef, path); assertOwner();
    const remote = await store.read(registration.remoteInputRef, path); assertOwner();
    if (marker.kind !== "merge-input" || local.kind !== "merge-input" || remote.kind !== "merge-input" ||
      registration.confirmedMarkerHash !== marker.hash ||
      !equalBytes(marker.bytes, wholeDocumentMarkers(local.bytes, remote.bytes)))
      throw new Error("Invalid registered conflict body");
    history.conflict = { registration, marker };
  }
  if (content.status === "content-conflict" && !history.conflict)
    throw new Error("Conflict identity has no verified registration");
  if (content.status === "merge-pending" && !content.operationRef)
    throw new Error("Merge identity has no operation reference");
  return history;
}
