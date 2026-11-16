import type { NextclawSyncRecord } from "../../localdb";
import { observation } from "../engine/model";
import { hashBytes, type Snapshot } from "./identity";
import { loadContentHistory, strongEtag } from "./migration";
import type { OperationRepository } from "./operation";
import { ContentStore } from "./store";
export interface RollbackSource {
  /** Both calls must enumerate the complete fixed scope, including records and both file sets. */
  enumerate(): Promise<string[]>;
  record(path: string): Promise<{ generation: string; value: NextclawSyncRecord }>;
  local(path: string): Promise<Snapshot>;
  remote(path: string): Promise<Snapshot>;
}
/** Prepares an export only. Never enables an old writer, clears a journal, or writes either side. */
export async function prepareLegacyExport(scope: string, source: RollbackSource, bodies: ContentStore,
  operations: OperationRepository, guard: () => void): Promise<{ activateOldWriter: false; sha256: string; records: NextclawSyncRecord[] }> {
  guard();
  if ((await operations.list(scope)).some(o => !["committed", "archived"].includes(o.phase))) throw new Error("rollback-pending-operation");
  guard(); const paths = (await source.enumerate()).sort(); guard();
  if (new Set(paths).size !== paths.length) throw new Error("rollback-incomplete-scope");
  const records: NextclawSyncRecord[] = [], identities: { path: string; generation: string; hash: string; etag?: string }[] = [];
  for (const path of paths) {
    if (!path || path !== path.normalize("NFC") || path.includes("\0") || path.split("/").some(x => !x || x === "." || x === ".."))
      throw new Error("rollback-invalid-path");
    const checkpoint = await source.record(path); guard();
    const content = checkpoint.value.content;
    if (content?.status !== "clean" || content.conflictRef || content.operationRef || checkpoint.value.pendingLocalUpload)
      throw new Error("rollback-content-pending");
    const history = await loadContentHistory({ scope, path, store: bodies, rawRecord: checkpoint.value, assertOwner: guard });
    if (history.pendingLocalUpload || history.content?.status !== "clean" || history.content.conflictRef ||
      history.content.operationRef || history.content.acknowledgedUploadRef || !history.base)
      throw new Error("rollback-content-pending");
    const local = await source.local(path); guard(); const remote = await source.remote(path); guard();
    if (local.hash !== await hashBytes(local.bytes) || remote.hash !== await hashBytes(remote.bytes) ||
      local.hash !== remote.hash || local.hash !== history.base.hash || content.localHash !== local.hash ||
      content.remoteHash !== remote.hash || content.remoteEtag !== remote.entity.etag || !strongEtag(remote.entity.etag) || local.entity.key !== path || remote.entity.key !== path)
      throw new Error("rollback-content-mismatch");
    records.push({ keyRaw: path, sizeRaw: local.bytes.byteLength, v: 1, key: path, isFolder: false, local: observation(local.entity, "local"), remote: observation(remote.entity, "remote") });
    identities.push({ path, generation: checkpoint.generation, hash: local.hash, etag: remote.entity.etag });
  }
  for (const identity of identities) {
    const r = await source.record(identity.path); guard();
    const l = await source.local(identity.path); guard(); const remote = await source.remote(identity.path); guard();
    if (r.generation !== identity.generation || await hashBytes(l.bytes) !== identity.hash ||
      await hashBytes(remote.bytes) !== identity.hash || remote.entity.etag !== identity.etag)
      throw new Error("rollback-source-changed");
  }
  if (JSON.stringify((await source.enumerate()).sort()) !== JSON.stringify(paths)) throw new Error("rollback-scope-changed");
  guard();
  const sha256 = await hashBytes(new TextEncoder().encode(JSON.stringify(records)).buffer); guard();
  return { activateOldWriter: false, records, sha256 };
}
