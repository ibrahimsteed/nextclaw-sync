import { inConfig } from "../engine/model";
import { ATTACHMENT_LIMIT, hashBytes, NOTE_LIMIT } from "./identity";
import { loadContentHistory, strongEtag } from "./migration";
import { markerState } from "./markers";

export type ContentAction = "none" | "delegate-pull-only" | "delegate-merge-plugins" |
  "prepare-base" | "upload-create" | "download-create" | "upload" | "download" |
  "merge-three-way" | "conflict-two-way" | "preserve-both" | "resolve-local" | "hold" |
  "delete-local" | "delete-remote" | "delete-record";
export interface ContentPlan {
  action: ContentAction;
  status: "none" | "delegated" | "ready" | "pending" | "content-conflict" | "failed" | "blocked-unknown-write";
  reason: string;
  fullyConverged: false; // No execution/record commit has occurred in a planner.
  fatalBudgetDelta: 0 | 1;
  expected?: { scope: string; path: string; localHash?: string; remoteHash?: string;
    remoteEtag?: string; baseRef?: string; conflictRef?: string };
}
export interface ContentPlanInput extends Omit<Parameters<typeof loadContentHistory>[0], "assertOwner"> {
  mode: "A" | "B"; configDir: string;
  ownerActive(): boolean;
  unknownWrite: boolean;
  deletion?: { confirmedMissing: boolean; suspectedMove: boolean; reseed?: boolean };
  local?: { bytes: ArrayBuffer };
  remote?: { bytes: ArrayBuffer; etag: string; remoteFileId?: string };
}
/** Plans only: does not transfer, clear a journal, write records, or claim convergence. */
export async function planContent(input: ContentPlanInput): Promise<ContentPlan> {
  const result = (action: ContentAction, status: ContentPlan["status"], reason: string,
    expected?: ContentPlan["expected"]): ContentPlan => ({ action, status, reason,
    fullyConverged: false, fatalBudgetDelta: status === "failed" ? 1 : 0, ...(expected ? { expected } : {}) });
  const retired = () => result("none", "none", "retired-owner-no-write");
  if (!input.ownerActive()) return retired();
  if (input.unknownWrite) return result("hold", "blocked-unknown-write", "retain-native-journal");
  if (!input.scope || input.store.scope !== input.scope || !input.configDir || !input.path || input.path.endsWith("/") || input.path.includes("\0") ||
    input.path.split("/").some(x => x === "" || x === "." || x === ".."))
    return result("hold", "failed", "invalid-content-path");
  // A and B config retain the existing engine's pull-only/student-plugin policy.
  if (input.mode === "A" || inConfig(input.path, input.configDir))
    return result(input.path === `${input.configDir.replace(/\/+$/, "")}/community-plugins.json`
      ? "delegate-merge-plugins" : "delegate-pull-only", "delegated", "existing-config-policy");
  const assertOwner = () => {
    if (!input.ownerActive()) throw new Error("retired-content-owner");
    if (input.unknownWrite) throw new Error("retain-native-journal");
  };
  try {
    let history = await loadContentHistory({ ...input, assertOwner }); assertOwner();
    // A stage without a durable operation-completion check is not replayable.
    if (history.content?.operationRef)
      return result("hold", "pending", "keep-unconfirmed-stage");
    const limit = input.store.attachment ? ATTACHMENT_LIMIT : NOTE_LIMIT;
    if ((input.local?.bytes.byteLength ?? 0) > limit || (input.remote?.bytes.byteLength ?? 0) > limit)
      return result("hold", "pending", "content-limit-pending");
    const remoteEtag = input.remote?.etag;
    const l = input.local?.bytes.slice(0), r = input.remote?.bytes.slice(0);
    const [lh, rh] = await Promise.all([l ? hashBytes(l) : undefined, r ? hashBytes(r) : undefined]); assertOwner();
    const expected: NonNullable<ContentPlan["expected"]> = { scope: input.scope, path: input.path,
      localHash: lh, remoteHash: rh, remoteEtag, baseRef: history.content?.cleanBaseRef,
      conflictRef: history.content?.conflictRef };
    const plan = (action: ContentAction, status: ContentPlan["status"], reason: string) => result(action, status, reason, expected);
    if (r && !strongEtag(remoteEtag)) return plan("hold", "pending", "strong-remote-version-required");
    if (history.conflict) {
      const { marker, registration } = history.conflict;
      if (!l || !r) return plan("hold", "content-conflict", "keep-known-conflict");
      if (lh === marker.hash && rh === marker.hash) return plan("hold", "content-conflict", "keep-known-conflict");
      if (rh !== marker.hash && lh === marker.hash) return plan("hold", "pending", "report-remote-resolution");
      if (rh !== marker.hash || remoteEtag !== registration.remoteEtag)
        return plan("hold", "pending", "report-stale-resolution");
      if (markerState(l, true) !== "clear") return plan("hold", "content-conflict", "keep-known-conflict");
      return plan("resolve-local", "ready", "bound-local-resolution-intent");
    }
    const lm = l ? markerState(l) : "clear", rm = r ? markerState(r) : "clear";
    if ([lm, rm].some(x => x === "roles" || x === "ambiguous"))
      return plan("hold", "pending", "report-external-marker");
    if (history.content?.status === "deleted") {
      if (!l && !r) return plan(input.deletion?.confirmedMissing ? "none" : "hold",
        input.deletion?.confirmedMissing ? "none" : "pending", "verify-deleted-path");
      // A tombstone is not the common ancestor of a newly created file.
      history = { ...history, identity: "new", base: undefined };
    }
    if (!l || !r) {
      if (history.base) {
        if (!input.deletion) return plan("hold", "pending", "delete-pending-P2");
        if (history.pendingLocalUpload || history.content?.status !== "clean") return plan("hold", "pending", "unsettled-delete-intent");
        if (input.deletion.suspectedMove) return plan("hold", "pending", "suspected-file-move");
        if (!r && input.deletion.reseed && l) return plan("upload-create", "ready", "verified-root-reseed-local");
        if (!r && !input.deletion.confirmedMissing) return plan("hold", "pending", "missing-file-not-confirmed");
        if (!l && !r) return plan("delete-record", "ready", "both-explicitly-absent");
        if (!l) return plan(rh === history.base.hash ? "delete-remote" : "download-create", "ready",
          rh === history.base.hash ? "local-delete-unchanged-remote" : "remote-edit-survives-local-delete");
        return plan(lh === history.base.hash ? "delete-local" : "upload-create", "ready",
          lh === history.base.hash ? "remote-delete-unchanged-local" : "local-edit-survives-remote-delete");
      }
      if (history.identity !== "new") return plan("hold", "pending", "migration-pending");
      return plan(l ? "upload-create" : r ? "download-create" : "none", l || r ? "ready" : "none", "new-path");
    }
    if (lh === rh && history.content?.status === "clean" && history.base?.hash === lh &&
      history.content.localHash === lh && history.content.remoteHash === rh && history.content.remoteEtag === remoteEtag && history.content.remoteFileId === input.remote?.remoteFileId &&
      !history.pendingLocalUpload) return plan("none", "none", "verified-clean-base");
    if (lh === rh) return plan("prepare-base", "ready", "equal-current-bytes");
    if (history.pendingLocalUpload && history.acknowledged?.hash === rh)
      return plan("upload", "ready", "acknowledged-upload-tail-edit");
    if (!history.base) {
      return plan(input.path.toLowerCase().endsWith(".md") && lm !== "binary" && rm !== "binary"
        ? "conflict-two-way" : "preserve-both", "content-conflict", "unbased-different-bytes");
    }
    if (rh === history.base.hash) return plan("upload", "ready", "only-local-changed");
    if (lh === history.base.hash) return plan("download", "ready", "only-remote-changed");
    return plan(input.path.toLowerCase().endsWith(".md") && lm !== "binary" && rm !== "binary"
      ? "merge-three-way" : "preserve-both", input.path.toLowerCase().endsWith(".md") && lm !== "binary" && rm !== "binary" ? "ready" : "content-conflict", "both-changed");
  } catch (error) {
    if (!input.ownerActive()) return retired();
    if (input.unknownWrite) return result("hold", "blocked-unknown-write", "retain-native-journal");
    return result("hold", "failed", error instanceof Error ? error.message : "content-storage-failure");
  }
}
