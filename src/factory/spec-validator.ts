/**
 * Spec quality validation (plan §9.4), checked at the spec gate.
 *
 * Heuristics, not a rigid template: the analyst writes markdown in many shapes
 * (requirement ids as headings, list leads or inline), so every check errs on
 * the side of accepting a reasonable spec. Pure module; never throws.
 */

export interface SpecIssue {
  /** FR-/NFR- id the issue belongs to, when specific. */
  requirement?: string;
  message: string;
}

export interface SpecValidation {
  ok: boolean;
  frs: string[];
  nfrs: string[];
  issues: SpecIssue[];
  /** One-line human summary, e.g. "6 functional, 2 non-functional, 1 issue". */
  summary: string;
}

/** Requirement ids: FR-001, NFR-12 — matched case-insensitively, reported upper-case. */
const ID_RE = /\b(?:FR|NFR)-\d+\b/i;
const HEADING_RE = /^(#{1,6})[ \t]+([^\n]*)$/gm;
const TRACE_TITLE_RE = /traceability/i;
const EXCLUDED_TITLE_RE = /\b(?:out of scope|out-of-scope|non-goals?|not in scope)\b/i;
/** Markdown decoration allowed before the first content token of a line. */
const LEAD_DECOR_RE = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)*(?:\*\*|__|\*|_)?\s*/;
/** Unit tokens that turn digits into a measurement; co-occurrence within one
 * NFR slice is enough (no distance rule — that would reject honest phrasings). */
const UNIT_RE =
  /\b(?:ms|s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|day|days|week|weeks|month|months|year|years|rps|qps|req\/s|reqs?\/(?:sec|s)|requests?|users?|concurrent|concurrency|MB|MiB|GB|GiB|KB|KiB|TB|TiB|bytes?|p90|p95|p99|percentile|uptime|availability|celsius|fahrenheit|coins?|times?)\b|[%$°]/i;
/** Comparison phrasings that make a bare number a threshold. */
const COMPARISON_RE =
  /(?:[<>=≤≥]\s*\d|\b(?:at least|at most|no more than|no fewer than|fewer than|less than|more than|greater than|up to|within|under|over|minimum|maximum)\s+[-+]?\d)/i;
/** Source markers tying an FR back to the interview, assumptions or brief. */
const SOURCE_RE = /\b(?:answers?|assumptions?|assumed|brief|interview|q&a|questions?|q\d+)\b/i;
/** Longest distance between "given", "when" and "then" in one criterion. */
const GWT_WINDOW = 600;

interface Anchor {
  id: string;
  kind: "fr" | "nfr";
  start: number;
  end: number;
  lineEnd: number;
}

interface Section {
  level: number;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  title: string;
}

function scan(re: RegExp, text: string): RegExpExecArray[] {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const matches: RegExpExecArray[] = [];
  for (let m = rx.exec(text); m !== null; m = rx.exec(text)) {
    if (m[0].length > 0) matches.push(m);
    else rx.lastIndex += 1;
  }
  return matches;
}

function sectionsOf(text: string): Section[] {
  const found: Section[] = scan(HEADING_RE, text).map((m) => ({
    level: m[1].length,
    start: m.index,
    bodyStart: m.index + m[0].length,
    bodyEnd: text.length,
    title: m[2],
  }));
  for (let i = 0; i < found.length; i += 1) {
    const next = found.slice(i + 1).find((h) => h.level <= found[i].level);
    found[i].bodyEnd = next ? next.start : text.length;
  }
  return found;
}

/** All three keywords present within GWT_WINDOW characters of each other. */
function hasGwt(slice: string): boolean {
  const at = (word: string) => scan(new RegExp(`\\b${word}\\b`, "gi"), slice).map((m) => m.index);
  const givens = at("given");
  const whens = at("when");
  const thens = at("then");
  for (const g of givens) {
    for (const w of whens) {
      if (Math.abs(w - g) > GWT_WINDOW) continue;
      for (const t of thens) {
        if (Math.max(g, w, t) - Math.min(g, w, t) <= GWT_WINDOW) return true;
      }
    }
  }
  return false;
}

function analyze(text: string): [string[], string[], SpecIssue[]] {
  const sections = sectionsOf(text);
  const isTrace = (s: Section) => TRACE_TITLE_RE.test(s.title);
  // Traceability and out-of-scope sections only refer to requirements: ids there
  // anchor no slices and cause no duplicate hits, so back-references do not
  // masquerade as definitions.
  const excluded = sections.filter((s) => isTrace(s) || EXCLUDED_TITLE_RE.test(s.title));
  const inExcluded = (at: number) => excluded.some((s) => at >= s.start && at < s.bodyEnd);

  const occurrences: Anchor[] = scan(ID_RE, text)
    .filter((m) => !inExcluded(m.index))
    .map((m) => ({
      id: m[0].toUpperCase(),
      kind: /^nfr/i.test(m[0]) ? ("nfr" as const) : ("fr" as const),
      start: m.index,
      end: m.index + m[0].length,
      lineEnd: text.indexOf("\n", m.index) === -1 ? text.length : text.indexOf("\n", m.index),
    }));

  // Association heuristic: a requirement owns the text from its id up to the
  // next requirement id or excluded section. Only ids heading a line, heading or
  // list item define requirements; if a spec uses no such form (ids only ever
  // inline), fall back to every occurrence so it still gets checked.
  const isLeading = (a: Anchor): boolean => {
    const lineStart = text.lastIndexOf("\n", a.start - 1) + 1;
    const decor = text.slice(lineStart, a.lineEnd).match(LEAD_DECOR_RE);
    return a.start - lineStart === (decor ? decor[0].length : 0);
  };
  const leading = occurrences.filter(isLeading);
  const anchors = leading.length > 0 ? leading : occurrences;

  const boundAfter = (a: Anchor): number => {
    let end = text.length;
    for (const other of anchors) if (other.start > a.start && other.start < end) end = other.start;
    for (const s of excluded) if (s.start > a.start && s.start < end) end = s.start;
    return end;
  };
  const nextHeadingAfter = (a: Anchor): number => {
    for (const s of sections) if (s.start > a.lineEnd) return s.start;
    return text.length;
  };

  const frs: string[] = [];
  const nfrs: string[] = [];
  const first = new Map<string, Anchor>();
  for (const a of anchors) {
    if (first.has(a.id)) continue;
    first.set(a.id, a);
    (a.kind === "fr" ? frs : nfrs).push(a.id);
  }

  const issues: SpecIssue[] = [];
  if (frs.length === 0) issues.push({ message: "no functional requirements (FR-xxx) found" });

  // Duplicates need the leading form: prose mentions ("extends FR-001") repeat
  // ids legitimately, so they must not count.
  if (leading.length > 0) {
    const flagged = new Set<string>();
    for (const a of anchors) {
      if (first.get(a.id) === a || flagged.has(a.id)) continue;
      flagged.add(a.id);
      issues.push({ requirement: a.id, message: `duplicate requirement id ${a.id}` });
    }
  }

  for (const id of frs) {
    const a = first.get(id);
    if (!a) continue;
    if (hasGwt(text.slice(a.start, boundAfter(a)))) continue;
    // Shared-criteria rescue: retry with the slice extended to the next heading,
    // so FRs listed in one block and covered by a single combined
    // Given/When/Then do not fail.
    if (!hasGwt(text.slice(a.start, nextHeadingAfter(a)))) {
      issues.push({ requirement: id, message: `${id} has no Given/When/Then acceptance criterion` });
    }
  }

  for (const id of nfrs) {
    const a = first.get(id);
    if (!a) continue;
    const content = text.slice(a.end, boundAfter(a));
    if (!/[a-z0-9]/i.test(content)) {
      issues.push({ requirement: id, message: `${id} has no requirement text` });
      continue;
    }
    if (!(/\d/.test(content) && (UNIT_RE.test(content) || COMPARISON_RE.test(content)))) {
      issues.push({ requirement: id, message: `${id} is not measurable (no numeric threshold)` });
    }
  }

  if (frs.length > 0) {
    const traceSection = sections
      .filter(isTrace)
      .some((s) => ID_RE.test(text.slice(s.bodyStart, s.bodyEnd)));
    const citedInline = frs.every((id) => {
      const a = first.get(id);
      return a ? SOURCE_RE.test(text.slice(a.start, boundAfter(a))) : false;
    });
    if (!traceSection && !citedInline) {
      issues.push({
        message: "no traceability section: map each FR to an interview answer, a stated assumption or the brief",
      });
    }
  }

  return [frs, nfrs, issues];
}

function summarize(frs: string[], nfrs: string[], issues: SpecIssue[]): SpecValidation {
  const n = issues.length;
  return {
    ok: n === 0,
    frs,
    nfrs,
    issues,
    summary: `${frs.length} functional, ${nfrs.length} non-functional requirements, ${
      n === 0 ? "no issues" : `${n} issue${n === 1 ? "" : "s"}`
    }`,
  };
}

export function validateSpec(text: string): SpecValidation {
  const src = typeof text === "string" ? text : "";
  if (src.trim().length === 0) return summarize([], [], [{ message: "the spec is empty" }]);
  try {
    const [frs, nfrs, issues] = analyze(src);
    return summarize(frs, nfrs, issues);
  } catch (error) {
    return summarize([], [], [
      { message: `spec could not be validated: ${error instanceof Error ? error.message : String(error)}` },
    ]);
  }
}
