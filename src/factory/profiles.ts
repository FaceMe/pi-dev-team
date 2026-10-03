/**
 * Stack profile templates (plan §11.1). The architect starts from the closest
 * match instead of inventing gate commands. Every template keeps the gates
 * normalizeProfile requires ("test"; the others are the usual set); each
 * template is a starting point to adjust, never a fixed answer.
 */

export interface ProfileTemplate {
  /** Stable identifier, e.g. "node-ts-api". */
  id: string;
  /** Display name. */
  label: string;
  /** The profile "stack" string a run would adopt. */
  stack: string;
  /** Lowercase tokens matched against stack/spec text. */
  keywords: string[];
  /** Non-interactive, exit non-zero on failure, run from the repo root. */
  gates: Array<{ name: string; command: string }>;
  manifests: string[];
  /** One-line hints the architect should respect when adopting. */
  notes: string[];
}

export const PROFILE_TEMPLATES: readonly ProfileTemplate[] = [
  {
    id: "node-ts-api",
    label: "Node + TypeScript API",
    stack: "TypeScript 5 + Node 22 (Express or Fastify) + Vitest",
    keywords: ["node", "nodejs", "typescript", "ts", "npm", "api", "rest", "restful", "server", "endpoint", "express", "fastify", "hono"],
    gates: [
      { name: "install", command: "npm install" },
      { name: "build", command: "npm run build" },
      { name: "typecheck", command: "npx tsc --noEmit" },
      { name: "lint", command: "npx eslint ." },
      { name: "test", command: "npm test -- --run" },
    ],
    manifests: ["package.json"],
    notes: ['The test gate assumes vitest behind a "test" script; adjust to the repo\'s test runner.'],
  },
  {
    id: "react-vite",
    label: "React + Vite web app",
    stack: "React 19 + Vite 6 + TypeScript 5 + Vitest",
    keywords: ["react", "vite", "frontend", "spa", "ui", "typescript", "tsx", "jsx"],
    gates: [
      { name: "install", command: "npm install" },
      { name: "build", command: "npm run build" },
      { name: "typecheck", command: "npx tsc -b" },
      { name: "lint", command: "npx eslint ." },
      { name: "test", command: "npm test -- --run" },
    ],
    manifests: ["package.json"],
    notes: [
      'The test gate assumes vitest behind a "test" script; adjust to the repo\'s test runner.',
      'Add an "e2e" gate (for example playwright) once the project has end-to-end tests.',
    ],
  },
  {
    id: "python-fastapi",
    label: "Python + FastAPI service",
    stack: "Python 3.12 + FastAPI + uv (ruff, mypy, pytest)",
    keywords: ["python", "fastapi", "pydantic", "uvicorn", "uv", "pytest", "pip", "flask", "django", "sqlalchemy"],
    gates: [
      { name: "install", command: "uv sync" },
      { name: "lint", command: "uv run ruff check ." },
      { name: "typecheck", command: "uv run mypy ." },
      { name: "test", command: "uv run pytest -q" },
    ],
    manifests: ["pyproject.toml", "uv.lock"],
    notes: ["When uv is not the package manager, fall back to `pip install -e .` for install and `python -m pytest -q` for test."],
  },
];

/** Match templates by keyword overlap with the stack answer and the spec text, best first. */
export function matchProfileTemplates(stackText: string, specText: string): ProfileTemplate[] {
  const tokens = new Set(
    `${stackText} ${specText}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return PROFILE_TEMPLATES.map((template, index) => ({ template, index, score: template.keywords.filter((k) => tokens.has(k)).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.template);
}

/** Compact markdown block for the architect prompt; "" when there are no matches. */
export function templatesForPrompt(matches: ProfileTemplate[]): string {
  if (matches.length === 0) return "";
  const blocks = matches.map((t) =>
    [
      `#### ${t.id} — ${t.label}`,
      `- Stack: ${t.stack}`,
      `- Gates: ${t.gates.map((g) => `${g.name}: \`${g.command}\``).join("; ")}`,
      `- Manifests: ${t.manifests.join(", ")}`,
      ...t.notes.map((note) => `- ${note}`),
    ].join("\n"),
  );
  return `Closest stack profile templates (best first):\n\n${blocks.join("\n\n")}`;
}
