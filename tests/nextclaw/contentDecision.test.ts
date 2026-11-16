import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { createHash } from "crypto";
import fixtures from "./fixtures/p0-content-cases.json";
import { ContentStore, type ContentTable, type BodyObject } from "../../src/nextclaw/content/store";
import { planContent, type ContentPlanInput } from "../../src/nextclaw/content/decision";
import { loadContentHistory } from "../../src/nextclaw/content/migration";
import { markerState, wholeDocumentMarkers } from "../../src/nextclaw/content/markers";
import { scopeKey, NOTE_LIMIT, PROFILE_LIMIT } from "../../src/nextclaw/content/identity";
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const corpus = fixtures.corpus as Record<string, { utf8: string; sha256: string; bytes: number }>;
const body = (id: string) => bytes(corpus[id].utf8);
const scope = "dedicated-synthetic-scope", owner = () => {};
class Table implements ContentTable {
  map = new Map<string, unknown>(); writes = 0;
  async keys() { return [...this.map.keys()]; }
  async getItem<T>(key: string) { return (this.map.get(key) ?? null) as T | null; }
  async setItem<T>(key: string, v: T) { this.writes++; this.map.set(key, structuredClone(v)); }
}
function record(path: string, content?: unknown) {
  return { v: 1, key: path, isFolder: false, local: { mtime: 1000, size: 4 },
    remote: { mtime: 1000, size: 4, etag: "E1" }, ...(content ? { content } : {}) };
}
const baseContent = (ref: string) => ({ version: 1, scopeKey: scope, status: "clean", cleanBaseRef: ref });
const core: Record<string, [string, string]> = {
  M01: ["prepare-base", "equal-current-bytes"], M02: ["conflict-two-way", "unbased-different-bytes"],
  M03: ["hold", "migration-pending"], M04: ["hold", "migration-pending"], M05: ["hold", "migration-pending"],
  M06: ["preserve-both", "unbased-different-bytes"], M07: ["hold", "Missing or invalid content object"],
  N01: ["upload-create", "new-path"], N02: ["download-create", "new-path"], N03: ["none", "new-path"],
  Q01: ["prepare-base", "equal-current-bytes"], Q02: ["prepare-base", "equal-current-bytes"],
  Q03: ["upload", "only-local-changed"], Q04: ["download", "only-remote-changed"],
  Q05: ["merge-three-way", "both-changed"], Q06: ["preserve-both", "both-changed"],
  Q07: ["upload", "only-local-changed"], Q08: ["upload", "only-local-changed"],
  C01: ["hold", "keep-known-conflict"], C02: ["hold", "keep-known-conflict"], C03: ["hold", "keep-known-conflict"],
  C04: ["prepare-base", "equal-current-bytes"], C05: ["prepare-base", "equal-current-bytes"],
  C06: ["hold", "report-external-marker"], C07: ["hold", "report-external-marker"], C08: ["hold", "keep-known-conflict"],
  R01: ["resolve-local", "bound-local-resolution-intent"], R02: ["hold", "report-stale-resolution"],
  R03: ["hold", "report-stale-resolution"], R04: ["hold", "report-external-marker"], R06: ["hold", "report-remote-resolution"],
  F01: ["hold", "retain-native-journal"], F07: ["none", "retired-owner-no-write"], F08: ["hold", "keep-unconfirmed-stage"],
  S01: ["delegate-pull-only", "existing-config-policy"], S02: ["delegate-pull-only", "existing-config-policy"],
  S03: ["delegate-merge-plugins", "existing-config-policy"], S04: ["hold", "retain-native-journal"],
  D01: ["hold", "delete-pending-P2"], D02: ["hold", "delete-pending-P2"], D03: ["hold", "delete-pending-P2"],
  B01: ["preserve-both", "both-changed"], B02: ["hold", "content-limit-pending"],
  T02: ["hold", "retain-native-journal"], Y01: ["merge-three-way", "both-changed"],
  Y02: ["conflict-two-way", "unbased-different-bytes"], Y03: ["prepare-base", "equal-current-bytes"],
};
// Explicitly not implemented here: no stub receipts pretending to verify real commits.
const executionCases = ["R05", "F02", "F03", "F04", "F05", "F06", "B03", "T01", "T03"];
type CaseInput = { scope: string; local: string | null; remote: string | null; base: string | null;
  etag: string; owner: string; unknownWrite: boolean; legacy?: boolean; knownConflict?: boolean;
  baseRefCorrupt?: boolean; pendingLocalUpload?: boolean; stage?: string; bodyBytes?: number; expectedConflictEtag?: string };
async function setup(i: CaseInput) {
  const table = new Table(), store = new ContentStore(table, scope, owner);
  const path = i.scope === "B-config" ? ".obsidian/settings.json" : i.scope === "B-community-plugins"
    ? ".obsidian/community-plugins.json" : i.scope === "B-attachment" ? "asset.bin" : "note.md";
  let rawRecord: unknown = i.legacy ? record(path) : undefined;
  if (i.base) rawRecord = record(path, baseContent(await store.put(path, body(i.base), "clean-base")));
  if (i.baseRefCorrupt) rawRecord = record(path, baseContent(JSON.stringify(["nextclaw-content", 1, scope, path, "missing"])));
  let registration: unknown;
  if (i.knownConflict) {
    const markerRef = await store.put(path, body("M"), "merge-input");
    const localInputRef = await store.put(path, body("L"), "merge-input");
    const remoteInputRef = await store.put(path, body("R"), "merge-input");
    registration = { version: 1, id: "conflict-1", scope, path, markerRef, localInputRef, remoteInputRef,
      format: "whole-document-v1", confirmedMarkerHash: corpus.M.sha256, remoteEtag: i.expectedConflictEtag ?? "E1" };
    const r = rawRecord as ReturnType<typeof record>;
    rawRecord = { ...r, content: { ...(r.content as object), status: "content-conflict", conflictRef: "conflict-1" } };
  }
  if (i.stage) {
    const r = rawRecord as ReturnType<typeof record>;
    rawRecord = { ...r, content: { ...(r.content as object), status: "merge-pending", operationRef: "operation-1" } };
  }
  if (i.pendingLocalUpload) rawRecord = { ...(rawRecord as object), pendingLocalUpload: true };
  const input: ContentPlanInput = { scope, path, store, rawRecord, mode: i.scope === "A" ? "A" : "B", configDir: ".obsidian",
    ownerActive: () => i.owner === "active", unknownWrite: i.unknownWrite,
    local: i.local ? { bytes: i.bodyBytes ? new ArrayBuffer(i.bodyBytes) : body(i.local) } : undefined,
    remote: i.remote ? { bytes: body(i.remote), etag: i.etag } : undefined,
    readConflict: async () => structuredClone(registration) };
  return { input, table, store };
}
describe("P1 read-only migration/content plans against frozen P0 inputs", () => {
  it("accounts for every P0 case and independently verifies raw corpus hashes", () => {
    assert.deepEqual([...Object.keys(core), ...executionCases].sort(), fixtures.cases.map(c => c.id).sort());
    for (const v of Object.values(corpus)) {
      assert.equal(createHash("sha256").update(v.utf8).digest("hex"), v.sha256);
      assert.equal(Buffer.byteLength(v.utf8), v.bytes);
    }
  });
  for (const c of fixtures.cases.filter(c => c.id in core)) {
    it(`${c.id}: ${c.category} (decision, not completed execution)`, async () => {
      const { input, table } = await setup(c.input as CaseInput);
      const before = structuredClone([...table.map]), writes = table.writes;
      const p = await planContent(input);
      assert.deepEqual([p.action, p.reason], core[c.id]);
      const status = c.id === "M07" ? "failed" : p.reason === "retain-native-journal" ? "blocked-unknown-write" :
        p.action === "none" ? "none" : p.action.startsWith("delegate-") ? "delegated" :
        ["conflict-two-way", "preserve-both"].includes(p.action) || p.reason === "keep-known-conflict" ? "content-conflict" :
        p.action === "hold" ? "pending" : "ready";
      assert.equal(p.status, status);
      assert.equal(p.fullyConverged, false);
      assert.equal(p.fatalBudgetDelta, c.id === "M07" ? 1 : 0);
      if (p.expected) {
        assert.equal(p.expected.path, input.path); assert.equal(p.expected.scope, scope);
        if (c.input.local && c.id !== "B02") assert.equal(p.expected.localHash, corpus[c.input.local].sha256);
        if (c.input.remote) assert.equal(p.expected.remoteHash, corpus[c.input.remote].sha256);
        assert.equal(p.expected.remoteEtag, c.input.remote ? c.input.etag : undefined);
      }
      assert.equal(table.writes, writes); assert.deepEqual([...table.map], before);
    });
  }
  it("does not charge 12 attachment conflicts to the fatal budget or suppress an unrelated upload (B01)", async () => {
    let fatal = 0;
    for (let n = 0; n < 12; n++) {
      const { input } = await setup({ scope: "B-attachment", local: "L", remote: "R", base: "B", etag: "E1", owner: "active", unknownWrite: false });
      fatal += (await planContent(input)).fatalBudgetDelta;
    }
    assert.equal(fatal, 0);
    const { input } = await setup({ scope: "B-note", local: "L", remote: "B", base: "B", etag: "E1", owner: "active", unknownWrite: false });
    assert.equal((await planContent(input)).action, "upload");
  });
});
const common: CaseInput = { scope: "B-note", local: "L", remote: "B", base: "B", etag: "E1", owner: "active", unknownWrite: false };
describe("P1 migration integrity and priority boundaries", () => {
  it("rejects non-origin URLs instead of silently conflating server base paths", () => {
    assert.throws(() => scopeKey({ vault: "v", profile: "p", origin: "https://test.invalid/nextcloud", account: "s", remoteRoot: "r", configDir: ".obsidian", filterVersion: 1 }));
  });
  it("preserves legacy pendingLocalUpload without inventing a common ancestor", async () => {
    const { input, store } = await setup({ ...common, base: null, legacy: true, pendingLocalUpload: true });
    const h = await loadContentHistory({ ...input, store, assertOwner: owner });
    assert.equal(h.identity, "legacy"); assert.equal(h.pendingLocalUpload, true); assert.equal(h.base, undefined);
  });
  it("rejects unsupported capability, foreign scope/path and missing base; never falls back to metadata", async () => {
    const { input } = await setup(common);
    for (const content of [null, { version: 2 }, { version: 1, scopeKey: "foreign", status: "unbased" },
      { version: 1, scopeKey: scope, status: "clean" }]) {
      input.rawRecord = { ...record(input.path), content };
      assert.equal((await planContent(input)).status, "failed");
    }
    input.rawRecord = record("other.md"); assert.equal((await planContent(input)).status, "failed");
  });
  it("does not use merge-input, corrupt bytes or marker bodies as a clean ancestor", async () => {
    const { input, store, table } = await setup(common);
    const badKind = await store.put(input.path, body("B"), "merge-input");
    const marker = await store.put(input.path, body("M"), "clean-base");
    for (const ref of [badKind, marker]) {
      input.rawRecord = record(input.path, baseContent(ref)); assert.equal((await planContent(input)).status, "failed");
    }
    const ref = await store.put(input.path, body("B"), "clean-base");
    (table.map.get(ref) as BodyObject).bytes = body("L");
    input.rawRecord = record(input.path, baseContent(ref)); assert.equal((await planContent(input)).status, "failed");
  });
  it("requires a durable scope/path/ref/body bound registration, not a known-conflict flag", async () => {
    const { input } = await setup({ ...common, local: "S", remote: "M", knownConflict: true });
    const good = await input.readConflict!("conflict-1") as Record<string, unknown>;
    for (const change of [{ id: "other" }, { scope: "foreign" }, { path: "other.md" }, { remoteEtag: "W/E1" }, { markerRef: "lost" }, { localInputRef: "lost" }, { confirmedMarkerHash: corpus.L.sha256 }, { format: "future-format" }, { localInputRef: good.remoteInputRef }]) {
      input.readConflict = async () => ({ ...good, ...change });
      assert.equal((await planContent(input)).status, "failed");
    }
    input.readConflict = async () => good;
    input.remote!.etag = "E2";
    assert.equal((await planContent(input)).reason, "report-stale-resolution");
    input.remote!.etag = "E1";
    assert.equal((await planContent(input)).action, "resolve-local");
  });
  it("does not refresh old intent from a changed remote body even with the old ETag", async () => {
    const { input } = await setup({ ...common, local: "S", remote: "R", knownConflict: true });
    assert.equal((await planContent(input)).reason, "report-stale-resolution");
  });
  it("unknown and retired owners short circuit all storage, even for config", async () => {
    const { input, table } = await setup({ ...common, scope: "B-config", unknownWrite: true });
    table.getItem = async () => { throw Error("must not read"); };
    assert.equal((await planContent(input)).status, "blocked-unknown-write");
    input.ownerActive = () => false;
    assert.equal((await planContent(input)).reason, "retired-owner-no-write");
  });
  it("observes retirement or new global isolation across awaited base loads", async () => {
    for (const retire of [false, true]) {
      const { input, table } = await setup(common); const get = table.getItem.bind(table);
      table.getItem = async <T>(k: string) => { const v = await get<T>(k); if (retire) input.ownerActive = () => false; else input.unknownWrite = true; return v; };
      assert.equal((await planContent(input)).reason, retire ? "retired-owner-no-write" : "retain-native-journal");
    }
  });
  it("requires strong remote versions, uses original bytes for hashes and refuses binary automatic merge", async () => {
    const { input } = await setup(common);
    input.remote!.etag = "W/E1"; assert.equal((await planContent(input)).action, "hold");
    input.remote!.etag = ""; assert.equal((await planContent(input)).action, "hold");
    input.remote!.etag = "E1\r\nInjected"; assert.equal((await planContent(input)).action, "hold");
    input.remote!.etag = "E1";
    input.local!.bytes = new Uint8Array([255]).buffer;
    input.remote!.bytes = body("R"); assert.equal((await planContent(input)).action, "preserve-both");
  });
  it("binds the whole-document registration to independently preserved raw inputs", () => {
    assert.deepEqual(wholeDocumentMarkers(body("L"), body("R")), body("M"));
    const noLF = body("noLF"), copy = noLF.slice(0);
    wholeDocumentMarkers(noLF, body("R")); assert.deepEqual(noLF, copy);
    assert.throws(() => wholeDocumentMarkers(body("partial"), body("R")));
  });
  it("separates fenced examples, ambiguous fences and known partial markers", () => {
    assert.equal(markerState(bytes("```\n<<<<<<< Obsidian\n=======\n>>>>>>> Agent\n```\n")), "clear");
    assert.equal(markerState(bytes("```\n<<<<<<< Obsidian\n=======\n>>>>>>> Agent\n```\n"), true), "roles");
    assert.equal(markerState(bytes("Heading\n=======\n")), "clear");
    assert.equal(markerState(bytes("```\nopen")), "ambiguous");
  });
  it("keeps student plugin handling in the existing policy even in mode A", async () => {
    const { input } = await setup({ ...common, scope: "B-community-plugins" }); input.mode = "A";
    assert.equal((await planContent(input)).action, "delegate-merge-plugins");
  });
  it("B03 enforces the actual 32MiB profile limit without evicting old inputs", async () => {
    const table = new Table(), store = new ContentStore(table, scope, owner);
    for (let n = 0; n < PROFILE_LIMIT / NOTE_LIMIT; n++) await store.put(`input${n}`, new ArrayBuffer(NOTE_LIMIT), "merge-input");
    const before = table.writes;
    await assert.rejects(store.put("extra", bytes("x"), "merge-input"), /content-limit-pending/);
    assert.equal(table.writes, before);
  });
});
