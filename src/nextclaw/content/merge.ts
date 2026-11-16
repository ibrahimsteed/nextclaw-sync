import { decodeText, NOTE_LIMIT } from "./identity";
import { equalBytes } from "../engine/versionGuard";
import { markerState, wholeDocumentMarkers } from "./markers";
export type MergeResult = { kind: "clean" | "conflict"; bytes: ArrayBuffer } |
  { kind: "pending"; reason: string };
type Hunk = { start: number; end: number; lines: string[] };
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const MAX_CELLS = 1_000_000;
/** Bounded exact line diff. Prefix/suffix trimming keeps small edits in long notes cheap. */
function diff(base: string[], other: string[]): Hunk[] | undefined {
  let prefix = 0, endB = base.length, endO = other.length;
  while (prefix < endB && prefix < endO && base[prefix] === other[prefix]) prefix++;
  while (endB > prefix && endO > prefix && base[endB - 1] === other[endO - 1]) { endB--; endO--; }
  const a = base.slice(prefix, endB), b = other.slice(prefix, endO), width = b.length + 1;
  if ((a.length + 1) * width > MAX_CELLS) return;
  const matrix = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    matrix[i * width + j] = a[i] === b[j] ? 1 + matrix[(i + 1) * width + j + 1] :
      Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  const hunks: Hunk[] = []; let i = 0, j = 0, h: Hunk | undefined;
  const flush = () => { if (h) hunks.push(h); h = undefined; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else {
      h ??= { start: prefix + i, end: prefix + i, lines: [] };
      if (j < b.length && (i === a.length || matrix[i * width + j + 1] >= matrix[(i + 1) * width + j])) h.lines.push(b[j++]);
      else { i++; h.end = prefix + i; }
    }
  }
  flush(); return hunks;
}
// Insertions on an edit boundary are deliberately conflicting; never guess ordering.
function overlaps(a: Hunk, b: Hunk) {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
function frontmatter(text: string): string | undefined {
  const start = /^(?:\ufeff)?---\r?\n/.exec(text);
  if (!start) return "";
  const end = /^(?:---|\.\.\.)\r?$/m.exec(text.slice(start[0].length));
  return end ? text.slice(0, start[0].length + end.index + end[0].length) : undefined;
}
/** Raw bytes remain immutable inputs; generated conflicts use the agreed whole-document format. */
export function mergeContent(base: ArrayBuffer | undefined, local: ArrayBuffer, remote: ArrayBuffer): MergeResult {
  if ([base, local, remote].some(x => x && x.byteLength > NOTE_LIMIT)) return { kind: "pending", reason: "content-limit-pending" };
  if ([base, local, remote].some(x => x && markerState(x) !== "clear"))
    return { kind: "pending", reason: "ambiguous-or-nontext-input" };
  const bounded = (kind: "clean" | "conflict", output: ArrayBuffer): MergeResult => output.byteLength > NOTE_LIMIT
    ? { kind: "pending", reason: "content-limit-pending" } : kind === "clean" && markerState(output) !== "clear"
      ? { kind: "pending", reason: "ambiguous-merged-output" } : { kind, bytes: output };
  const conflict = () => bounded("conflict", wholeDocumentMarkers(local, remote));
  if (equalBytes(local, remote)) return bounded("clean", local.slice(0));
  if (!base) return conflict(); // No fictitious empty ancestor.
  if (equalBytes(local, base)) return bounded("clean", remote.slice(0));
  if (equalBytes(remote, base)) return bounded("clean", local.slice(0));
  const bt = decodeText(base), lt = decodeText(local), rt = decodeText(remote);
  const [bf, lf, rf] = [bt, lt, rt].map(frontmatter);
  if (bf === undefined || lf === undefined || rf === undefined || (lf !== bf && rf !== bf && lf !== rf)) return conflict();
  const bl = lines(bt), left = diff(bl, lines(lt)), right = diff(bl, lines(rt));
  if (!left || !right) return { kind: "pending", reason: "merge-work-limit-pending" };
  const changes = [...left];
  for (const h of right) {
    const intersect = left.filter(x => overlaps(x, h));
    if (!intersect.length) changes.push(h);
    else if (!(intersect.length === 1 && intersect[0].start === h.start && intersect[0].end === h.end && same(intersect[0].lines, h.lines)))
      return conflict();
  }
  const output = [...bl];
  for (const h of changes.sort((a, b) => b.start - a.start || b.end - a.end)) output.splice(h.start, h.end - h.start, ...h.lines);
  return bounded("clean", new TextEncoder().encode(output.join("")).buffer);
}
