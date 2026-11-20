import type { NextclawSyncRecord } from "../../localdb";
import { validContentRecord } from "./identity";
import type { OperationRepository } from "./operation";
import { ATTACHMENT_BODY, CONTENT_BODY, type ContentStore } from "./store";
import type { ContentTable } from "./store";
import type { committedMove } from "./move";
/** Only run under the full-sync owner gate, never in an admitted content operation. */
export async function collectContent(store: ContentStore, table: ContentTable & { removeItem(key: string): Promise<unknown> },
  operations: OperationRepository, records: { value: NextclawSyncRecord; commitId?: string }[], guard: () => void, deleted: { id: string; path: string; baseRef: string; baseHash: string; supersedes: string[]; phase?: string }[] = [],
  moveBase?: string, moved?: ReturnType<typeof committedMove>) {
  const scope = store.scope;
  guard(); const all = await operations.list(scope); guard();
  const operationsById = new Map(all.map(op => [op.id, op]));
  const recordsByPath = new Map<string, typeof records[number]>();
  const pins = new Set<string>(), active = new Set<string>();
  if (moveBase) pins.add(moveBase);
  for (const d of deleted) if (!["committed", "rejected", "rediscover"].includes(d.phase ?? "committed")) pins.add(d.baseRef);
  const add = (c: NextclawSyncRecord["content"]) => {
    if (!c) return;
    if (!validContentRecord(c)) throw new Error("GC拒绝损坏的内容能力");
    if (c.scopeKey !== scope) return;
    for (const ref of [c.cleanBaseRef, c.acknowledgedUploadRef]) if (ref) pins.add(ref);
    for (const ref of [c.conflictRef, c.operationRef]) if (ref) active.add(ref);
  };
  for (const r of records) {
    add(r.value.content);
    const c = r.value.content;
    if (c?.scopeKey === scope && !recordsByPath.has(r.value.key)) recordsByPath.set(r.value.key, r);
    if (c?.scopeKey === scope && c.cleanBaseRef) {
      const base = await store.read(c.cleanBaseRef, r.value.key); guard();
      if (base.kind !== "clean-base" || (c.status === "clean" && !r.value.pendingLocalUpload &&
        (base.hash !== c.localHash || base.hash !== c.remoteHash))) throw new Error("GC拒绝无效共同基线");
    }
  }
  for (const o of all) if (!["committed", "rejected", "rediscover", "archived"].includes(o.phase)) active.add(o.id);
  for (const id of active) {
    const o = operationsById.get(id); if (!o) throw new Error("GC活动引用缺失");
    for (const ref of [o.previous.content?.conflictRef, o.previous.content?.operationRef]) if (ref) active.add(ref);
  }
  // A new verified clean commit can retire settled history for that path. Unconfirmed operations never qualify.
  const movedTo = moved && records.find(r => r.value.key === moved.target && r.commitId === moved.id)?.value;
  for (const op of all) {
    const current = recordsByPath.get(op.path);
    const c = current?.value.content;
    const committing = current?.commitId && operationsById.get(current.commitId);
    const proof = committing && ["committed", "archived"].includes(committing.phase) &&
      committing.path === op.path && committing.outputKind === "clean" &&
      committing.outputHash === c?.localHash && committing.outputHash === c?.remoteHash ? committing : undefined;
    const deletionProof = deleted.find(d => (d.phase === undefined || d.phase === "committed") && d.id === current?.commitId && d.path === op.path && d.supersedes.includes(op.id) && c?.cleanBaseRef === undefined &&
      d.baseHash === c?.localHash && d.baseHash === c?.remoteHash && c?.status === "deleted");
    const moveProof = moved?.source === op.path && moved.sourceCommitId === op.id && !current &&
      movedTo?.content?.cleanBaseRef === moved.targetBase && movedTo.content.localHash === moved.hash &&
      movedTo.content.remoteHash === moved.hash && movedTo.content.status === "clean";
    if ((deletionProof || moveProof || (proof && (proof.id === op.id || proof.supersedes?.includes(op.id)) && c?.status === "clean" && !c.conflictRef && !c.operationRef && !c.acknowledgedUploadRef &&
      !current?.value.pendingLocalUpload)) && !active.has(op.id) && ["committed", "rejected", "rediscover"].includes(op.phase)) {
      guard(); op.phase = "archived"; op.retiredBy = deletionProof?.id ?? (moveProof ? moved.id : proof!.id); await operations.put(op); guard();
    }
  }
  const remaining = await operations.list(scope); guard();
  const remainingById = new Map(remaining.map(op => [op.id, op]));
  const pinOperation = (id: string) => {
    const o = remainingById.get(id);
    if (!o) throw new Error("GC找不到活动操作引用");
    for (const ref of [o.localRef, o.remoteRef, o.baseRef, o.outputRef]) if (ref) pins.add(ref);
    const old = o.previous.content;
    if (old) {
      for (const ref of [old.cleanBaseRef, old.acknowledgedUploadRef]) if (ref) pins.add(ref);
      for (const ref of [old.conflictRef, old.operationRef]) if (ref && !active.has(ref)) { active.add(ref); pinOperation(ref); }
    }
  };
  for (const o of remaining) if (o.phase !== "archived") active.add(o.id);
  for (const id of active) pinOperation(id);
  const currentIds = new Set(records.map(r => r.commitId).filter(Boolean));
  // Retain current commit evidence and every active conflict/dependency; remove only retired metadata.
  for (const op of remaining) if (op.phase === "archived" && !active.has(op.id) && !currentIds.has(op.id)) {
    guard(); await table.removeItem(JSON.stringify(["nextclaw-content-operation", 1, scope, op.id])); guard();
  }
  let removed = 0;
  for (const key of await table.keys()) {
    guard(); let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts) || (parts[0] !== CONTENT_BODY && parts[0] !== ATTACHMENT_BODY) || parts[2] !== scope) continue;
    if (parts[1] !== 1 || parts.length !== 5) throw new Error("GC拒绝未知正文版本");
    if (!pins.has(key)) { guard(); await table.removeItem(key); guard(); removed++; }
  }
  return removed;
}
