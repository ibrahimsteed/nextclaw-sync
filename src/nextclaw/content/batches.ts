/** Scheduling hints only. Never reuse a content observation or authorize a write. */
export const SMALL_BYTES = 64 * 1024;
export const SMALL_COUNT = 32;
export interface BatchState { version: 1; remaining: string[]; completed: string[]; issues?: { path: string; reason: string }[]; saveOnly?: true; }
export function selectBatch(entries: { path: string; size: number; urgent?: boolean }[], previous?: BatchState | null, saveOnly = false) {
  const sizes = new Map(entries.map(e => [e.path, e.size]));
  if (previous && (previous.version !== 1 || !Array.isArray(previous.remaining) ||
    !Array.isArray(previous.completed) || previous.completed.some(p => typeof p !== "string") ||
    (previous.saveOnly !== undefined && previous.saveOnly !== true) ||
    (previous.issues !== undefined && (!Array.isArray(previous.issues) || previous.issues.some(i => !i || typeof i.path !== "string" || typeof i.reason !== "string"))) ||
    previous.remaining.some(p => typeof p !== "string") ||
    new Set([...previous.remaining, ...previous.completed]).size !== previous.remaining.length + previous.completed.length))
    throw new Error("invalid-content-batch-state");
  // Full sweeps must revisit paths already served by a save-only sweep.
  if (!saveOnly && previous?.saveOnly)
    previous = { version: 1, remaining: [], completed: [], issues: previous.issues };
  const saveSweep = saveOnly && (!previous?.remaining.length || previous.saveOnly === true);
  const queue = (previous?.remaining ?? []).filter(p => sizes.has(p));
  const known = new Set([...queue, ...(previous?.completed ?? [])]);
  for (const {path} of entries) if (!known.has(path)) { queue.push(path); known.add(path); }
  // Revisit already-served small pages during a long sweep: a save (including
  // identical mtime/size) must not wait behind the remaining large backlog.
  // Durable F1 tails take priority, without consuming the oldest-item slot.
  const waiting = new Map(queue.map((p, index) => [p, index]));
  const small = entries.filter(e => e.size <= SMALL_BYTES)
    .sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) ||
      (waiting.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (waiting.get(b.path) ?? Number.MAX_SAFE_INTEGER))
    .slice(0, SMALL_COUNT).map(e => e.path);
  const chosen = new Set(small);
  const oldest = queue.find(p => !chosen.has(p));
  if (oldest !== undefined) { small.push(oldest); chosen.add(oldest); }
  const remaining = queue.filter(p => !chosen.has(p));
  return { selected: small, saveSweep, next: { version: 1 as const, remaining,
    ...(saveSweep && remaining.length ? { saveOnly: true as const } : {}),
    issues: (previous?.issues ?? []).filter(i => sizes.has(i.path)),
    completed: remaining.length ? [...new Set([...(previous?.completed ?? []).filter(p => sizes.has(p)), ...small])] : [] } };
}
