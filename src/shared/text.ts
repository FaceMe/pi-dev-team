/** Text helpers for compact UI lines and bounded log excerpts. */

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Bounded, line-preserving excerpt of a tool output for trace display. */
export function excerpt(text: string, maxChars: number, maxLines: number): string {
  const clean = String(text ?? "").replace(/\s+$/, "");
  if (!clean.trim()) return "";
  const lines = clean.split("\n");
  const kept = lines.slice(0, maxLines).join("\n");
  const out = kept.length > maxChars ? `${kept.slice(0, Math.max(0, maxChars - 1))}…` : kept;
  const extraLines = lines.length - Math.min(lines.length, maxLines);
  const extraChars = clean.length - out.length;
  if (extraChars > 0) {
    return `${out}\n… (+${extraChars} chars${extraLines > 0 ? `, +${extraLines} more line${extraLines === 1 ? "" : "s"}` : ""} truncated)`;
  }
  if (extraLines > 0) return `${out}\n… (+${extraLines} more line${extraLines === 1 ? "" : "s"})`;
  return out;
}

/** The last `maxChars` characters of a log, cut on a line boundary when possible. */
export function tail(text: string, maxChars: number): string {
  const clean = String(text ?? "").replace(/\s+$/, "");
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(clean.length - maxChars);
  const newline = cut.indexOf("\n");
  return `…${newline >= 0 && newline < 200 ? cut.slice(newline) : cut}`;
}

/** Text of a user or tool message whose content is a string or an array of parts. */
export function contentText(content: unknown, separator = "\n"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .filter(Boolean)
    .join(separator);
}
