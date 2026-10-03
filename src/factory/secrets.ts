/**
 * Secret scan (plan §15): runs on every ticket's diff before it merges into the
 * integration branch, and on the whole factory branch before release. Only
 * high-confidence patterns, so a hit is worth stopping for; workers are told to
 * use environment variables and document them in .env.example instead.
 */

export interface SecretFinding {
  file: string;
  line?: number;
  kind: string;
  /** The matched text with the middle redacted (never the full secret). */
  preview: string;
}

const PATTERNS: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["connection string with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]{6,})@/],
];

/** Values that are obviously placeholders, not secrets. */
const PLACEHOLDER = /(x{6,}|\.{3}|<[^>]+>|\$\{|changeme|example|placeholder|your[_-]|dummy|redacted|password@|pass(word)?@|secret@|test(ing)?@)/i;

/** Dotenv files that hold real values (examples and templates are fine). */
const ENV_FILE = /(^|\/)\.env(\.[\w-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;

function redact(text: string): string {
  const t = text.trim();
  if (t.length <= 10) return `${t.slice(0, 2)}…`;
  return `${t.slice(0, 6)}…${t.slice(-2)}`;
}

/** Scan lines of one file. */
export function scanText(file: string, text: string, firstLine = 1): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [kind, pattern] of PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      if (kind !== "private key" && PLACEHOLDER.test(m[0])) continue;
      findings.push({ file, line: firstLine + i, kind, preview: redact(m[0]) });
      break;
    }
  });
  return findings;
}

/** A committed dotenv file is a finding by itself: real values belong outside git. */
export function secretFiles(files: string[]): SecretFinding[] {
  return files
    .filter((file) => ENV_FILE.test(file) && !ENV_TEMPLATE.test(file))
    .map((file) => ({ file, kind: "dotenv file (commit .env.example instead)", preview: file }));
}

/** Scan the added lines of a unified diff (`git diff` output). */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const files: string[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? "" : target.replace(/^b\//, "");
      if (file) files.push(file);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+")) {
      findings.push(...scanText(file, raw.slice(1), line));
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line++;
    }
  }
  return [...secretFiles(files), ...findings];
}

export function describeSecrets(findings: SecretFinding[]): string {
  return findings
    .slice(0, 12)
    .map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} — ${f.kind} (${f.preview})`)
    .concat(findings.length > 12 ? [`- … and ${findings.length - 12} more`] : [])
    .join("\n");
}
