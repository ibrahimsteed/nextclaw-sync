import { decodeText } from "./identity";
/** Exact role lines, not arbitrary Markdown headings or inline text. */
export function markerState(bytes: ArrayBuffer, registered = false): "clear" | "roles" | "ambiguous" | "binary" {
  let text: string;
  try { text = decodeText(bytes); } catch { return "binary"; }
  let fence: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    // Registered role lines cannot be hidden inside a new fence. A lone separator is allowed (user decision 2026-10-22).
    if (registered && ["<<<<<<< Obsidian", ">>>>>>> Agent"].includes(line)) return "roles";
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      if (!fence) fence = { char: f[1][0], length: f[1].length };
      else if (f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      continue;
    }
    if (!fence && ["<<<<<<< Obsidian", ">>>>>>> Agent"].includes(line)) return "roles";
  }
  return fence ? "ambiguous" : "clear";
}

/** Whole-document v1 only. Inputs remain separately stored in their original bytes. */
export function wholeDocumentMarkers(local: ArrayBuffer, remote: ArrayBuffer): ArrayBuffer {
  if (markerState(local) !== "clear" || markerState(remote) !== "clear")
    throw new Error("Ambiguous conflict input");
  const line = (b: ArrayBuffer) => { const s = decodeText(b); return s.endsWith("\n") ? s : `${s}\n`; };
  return new TextEncoder().encode(`<<<<<<< Obsidian\n${line(local)}=======\n${line(remote)}>>>>>>> Agent\n`).buffer;
}
