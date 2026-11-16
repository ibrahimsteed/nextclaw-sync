import { strict as assert } from "assert";
import fixtures from "./fixtures/p0-content-cases.json";
import { mergeContent } from "../../src/nextclaw/content/merge";
import { markerState } from "../../src/nextclaw/content/markers";
import { NOTE_LIMIT } from "../../src/nextclaw/content/identity";
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const text = (b: ArrayBuffer) => new TextDecoder("utf8", { ignoreBOM: true }).decode(b);
const body = (id: keyof typeof fixtures.corpus) => bytes(fixtures.corpus[id].utf8);
function clean(b: string, l: string, r: string, expected: string) {
  const out = mergeContent(bytes(b), bytes(l), bytes(r)); assert.equal(out.kind, "clean");
  assert.equal(text(out.bytes), expected);
}
describe("P1 actual three-way merge and whole-document markers", () => {
  it("merges independent edits to different lines", () => clean("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "A\nb\nC\n"));
  it("handles distinct insertions, deletion, empty base and empty files", () => {
    clean("a\nb\nc\n", "x\na\nb\nc\n", "a\nb\nc\ny\n", "x\na\nb\nc\ny\n");
    clean("a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nD\n", "a\nc\nD\n");
    clean("", "", "new", "new"); clean("a\n", "", "", "");
  });
  it("deduplicates identical overlapping edits while preserving independent edits", () => {
    clean("a\nb\nc\nd\n", "A\nb\nc\nd\n", "A\nb\nc\nD\n", "A\nb\nc\nD\n");
  });
  it("conflicts on different changes to one line or same-position insertion", () => {
    for (const [b,l,r] of [["a\n", "A\n", "B\n"], ["a\n", "x\na\n", "y\na\n"]]) {
      const out = mergeContent(bytes(b), bytes(l), bytes(r)); assert.equal(out.kind, "conflict");
      assert.ok(text(out.bytes).includes(l)); assert.ok(text(out.bytes).includes(r));
    }
  });
  it("Q05/Y01/Y02: uses actual merge results and literal P0 marker bytes", () => {
    const out = mergeContent(body("B"), body("L"), body("R")); assert.equal(out.kind, "conflict");
    assert.deepEqual(out.bytes, body("M"));
    assert.equal(mergeContent(body("B"), body("yamlL"), body("yamlR")).kind, "conflict");
    const l = body("noLF"), copy = l.slice(0); const raw = mergeContent(undefined, l, body("R"));
    assert.equal(raw.kind, "conflict"); assert.deepEqual(l, copy);
  });
  it("preserves BOM, CRLF and missing final newline in clean merges", () => {
    clean("\ufeffa\r\nb\r\nc", "\ufeffA\r\nb\r\nc", "\ufeffa\r\nb\r\nC", "\ufeffA\r\nb\r\nC");
  });
  it("does not silently combine different frontmatter keys even when line edits do not overlap", () => {
    const base = bytes("---\nx: 1\ny: 1\n---\nbody\n");
    const left = bytes("---\nx: 2\ny: 1\n---\nbody\n");
    const right = bytes("---\nx: 1\ny: 2\n---\nbody\n");
    assert.equal(mergeContent(base, left, right).kind, "conflict");
  });
  it("one-side YAML change may merge with an independent body edit", () => {
    clean("---\nx: 1\n---\nbody\n", "---\nx: 2\n---\nbody\n", "---\nx: 1\n---\nchanged\n", "---\nx: 2\n---\nchanged\n");
  });
  it("refuses binary/ambiguous/marker inputs without generating nested markers", () => {
    assert.equal(mergeContent(body("B"), body("M"), body("R")).kind, "pending");
    assert.equal(mergeContent(undefined, new Uint8Array([255]).buffer, body("R")).kind, "pending");
    assert.equal(mergeContent(body("B"), bytes("```\nunclosed"), body("R")).kind, "pending");
  });
  it("bounds input, generated output and diff work instead of blocking unboundedly", () => {
    assert.equal(mergeContent(undefined, new ArrayBuffer(NOTE_LIMIT + 1), body("R")).kind, "pending");
    const large = bytes("x".repeat(NOTE_LIMIT));
    assert.equal(mergeContent(undefined, large, bytes("y")).kind, "pending");
    const b = bytes(Array.from({ length: 1100 }, (_, i) => `base${i}\n`).join(""));
    const l = bytes(Array.from({ length: 1100 }, (_, i) => `left${i}\n`).join(""));
    const r = bytes(Array.from({ length: 1100 }, (_, i) => `right${i}\n`).join(""));
    assert.deepEqual(mergeContent(b, l, r), { kind: "pending", reason: "merge-work-limit-pending" });
  });
  it("user-confirmed separator rule: legal heading and a leftover separator are both eligible", () => {
    for (const s of ["学习计划\n=======\n正文\n", "=======\n"]) assert.equal(markerState(bytes(s), true), "clear");
    assert.equal(markerState(bytes("```\n<<<<<<< Obsidian\n```\n"), true), "roles");
  });
  it("keeps independent tiny edits in a long note below the bounded diff window", () => {
    const b = Array.from({ length: 3000 }, (_, i) => `${i}\n`), l = [...b], r = [...b];
    l[10] = "local\n"; r[2990] = "remote\n";
    const expected = [...l]; expected[2990] = r[2990]; clean(b.join(""), l.join(""), r.join(""), expected.join(""));
  });
});
