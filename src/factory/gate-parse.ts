/**
 * Structured gate failures (plan §10.1): pull failing test names and compiler,
 * type-checker and linter diagnostics out of raw gate output, so a builder gets
 * "these 2 tests and this type error" first instead of a 6 KB log tail.
 *
 * Heuristic and tool-agnostic: it recognises the common output shapes of
 * tsc, eslint, gcc/clang/go/mypy-style `file:line[:col]: message`, rustc,
 * node:test (spec and TAP), vitest, jest, pytest, go test and cargo test.
 * Anything it misses is still in the raw tail that follows.
 */

export interface Diagnostic {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
}

export interface GateFailureDetails {
  tests: string[];
  errors: Diagnostic[];
}

const MAX_ITEMS = 20;

// Drop ANSI colour codes some tools print even with NO_COLOR.
const ANSI = /\u001b\[[0-9;]*m/g;

const TEST_PATTERNS: RegExp[] = [
  /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/, // TAP (node:test --test-reporter=tap)
  /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/, // node:test spec reporter
  /^\s*(?:FAIL)\s+(\S+\s+>\s+.+)$/, // vitest: FAIL file > suite > name
  /^\s*[×✗] (.+?)(?: \d+m?s)?$/, // vitest / mocha style crosses
  /^\s*● (.+? › .+)$/, // jest: ● suite › name
  /^FAILED (\S+::\S+)/, // pytest summary
  /^--- FAIL: (\S+)/, // go test
  /^test (\S+) \.\.\. FAILED$/, // cargo test
];

const IGNORED_TEST_NAMES = /^(failing tests:?|tests? failed.*|\d+ failed.*)$/i;

/** `src/a.ts(3,5): error TS2322: msg` */
const TSC_PAREN = /^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
/** `src/a.ts:3:5 - error TS2322: msg` */
const TSC_DASH = /^(\S+?):(\d+):(\d+) - error (TS\d+): (.+)$/;
/** gcc / clang / go / mypy / ruff: `file:line[:col]: [error:] message` */
const GENERIC = /^(\.{0,2}\/?[\w./@-]+\.[A-Za-z]\w*):(\d+)(?::(\d+))?:\s*(?:(?:fatal )?error(?:\[(\w+)\])?:\s*)?(.+)$/;
/** rustc: `error[E0308]: mismatched types` followed by `  --> src/main.rs:3:5` */
const RUST_HEAD = /^error(?:\[(E\d+)\])?: (.+)$/;
const RUST_LOC = /^\s*--> (\S+?):(\d+):(\d+)/;
/** eslint stylish: a file path line, then `  12:5  error  message  rule-name` */
const ESLINT_FILE = /^(\/|\.{0,2}\/?)?[\w./@-]+\.[A-Za-z]\w*$/;
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+error\s+(.+?)(?:\s{2,}([\w@/-]+))?$/;

function push<T>(list: T[], item: T, key: (x: T) => string): void {
  if (list.length >= MAX_ITEMS) return;
  if (list.some((existing) => key(existing) === key(item))) return;
  list.push(item);
}

const diagKey = (d: Diagnostic) => `${d.file ?? ""}:${d.line ?? ""}:${d.col ?? ""}:${d.message}`;

export function parseGateOutput(output: string): GateFailureDetails {
  const tests: string[] = [];
  const errors: Diagnostic[] = [];
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  let eslintFile: string | undefined;
  let rust: { code?: string; message: string } | undefined;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      eslintFile = undefined;
      continue;
    }

    let m = TSC_PAREN.exec(line) ?? TSC_DASH.exec(line);
    if (m) {
      push(errors, { file: m[1], line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5].trim() }, diagKey);
      continue;
    }

    m = RUST_HEAD.exec(line);
    if (m && !line.includes("could not compile")) {
      rust = { code: m[1], message: m[2].trim() };
      continue;
    }
    m = RUST_LOC.exec(line);
    if (m && rust) {
      push(errors, { file: m[1], line: Number(m[2]), col: Number(m[3]), code: rust.code, message: rust.message }, diagKey);
      rust = undefined;
      continue;
    }

    m = ESLINT_ROW.exec(line);
    if (m && eslintFile) {
      push(errors, { file: eslintFile, line: Number(m[1]), col: Number(m[2]), code: m[4], message: m[3].trim() }, diagKey);
      continue;
    }
    if (ESLINT_FILE.test(line.trim()) && !line.startsWith(" ")) {
      eslintFile = line.trim();
      continue;
    }

    let matchedTest = false;
    for (const pattern of TEST_PATTERNS) {
      const t = pattern.exec(line);
      if (t) {
        const name = t[1].trim();
        if (name && !IGNORED_TEST_NAMES.test(name)) push(tests, name, (x) => x);
        matchedTest = true;
        break;
      }
    }
    if (matchedTest) continue;

    if (!line.startsWith(" ") && !line.includes("://")) {
      m = GENERIC.exec(line);
      if (m) {
        const message = m[5].trim();
        // Skip warnings and notes; only errors make a gate fail.
        if (/^(warning|note|info)\b/i.test(message)) continue;
        push(errors, { file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, code: m[4], message }, diagKey);
      }
    }
  }
  return { tests, errors };
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}${d.col ? `:${d.col}` : ""} ` : "";
  return `${where}${d.code ? `${d.code} ` : ""}${d.message}`;
}

/** Markdown summary of the parsed failures; empty when nothing was recognised. */
export function formatGateFailureDetails(details: GateFailureDetails): string {
  const parts: string[] = [];
  if (details.tests.length) parts.push(`Failing tests (${details.tests.length}${details.tests.length >= MAX_ITEMS ? "+" : ""}):\n${details.tests.map((t) => `- ${t}`).join("\n")}`);
  if (details.errors.length) parts.push(`Errors (${details.errors.length}${details.errors.length >= MAX_ITEMS ? "+" : ""}):\n${details.errors.map((d) => `- ${formatDiagnostic(d)}`).join("\n")}`);
  return parts.join("\n\n");
}
