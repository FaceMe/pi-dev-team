import { describe, expect, it } from "vitest";
import { normalizeProfile } from "../src/factory/gates.js";
import { PROFILE_TEMPLATES, matchProfileTemplates, templatesForPrompt } from "../src/factory/profiles.js";
import { architecturePrompt, planningPrompt } from "../src/factory/prompts.js";
import type { Profile, SetupAnswers } from "../src/factory/types.js";

const answers = (overrides: Partial<SetupAnswers> = {}): SetupAnswers => ({
  teamPreset: "balanced",
  pins: {},
  autonomy: "balanced",
  projectMode: "new",
  stack: "auto",
  research: "off",
  deploy: "none",
  budgetUsd: 0,
  budgetTokens: 0,
  ...overrides,
});

const profile: Profile = {
  stack: "TypeScript 5 + Node 22 + Vitest",
  gates: [
    { name: "install", command: "npm install" },
    { name: "test", command: "npm test -- --run" },
  ],
  manifests: ["package.json"],
};

const template = (id: string) => PROFILE_TEMPLATES.find((t) => t.id === id)!;

describe("profile templates", () => {
  it("ships exactly the three M4 templates, each with install and test gates", () => {
    expect(PROFILE_TEMPLATES.map((t) => t.id)).toEqual(["node-ts-api", "react-vite", "python-fastapi"]);
    for (const t of PROFILE_TEMPLATES) {
      expect(t.label).toBeTruthy();
      expect(t.stack).toBeTruthy();
      expect(t.keywords.length).toBeGreaterThan(0);
      expect(t.notes.length).toBeGreaterThan(0);
      expect(t.manifests.length).toBeGreaterThan(0);
      const names = t.gates.map((g) => g.name);
      expect(names).toContain("install");
      expect(names).toContain("test");
      expect(t.gates.every((g) => g.command.trim() === g.command && g.command.length > 0)).toBe(true);
    }
  });

  it("pins the template gate commands and manifests", () => {
    expect(template("node-ts-api").gates).toEqual([
      { name: "install", command: "npm install" },
      { name: "build", command: "npm run build" },
      { name: "typecheck", command: "npx tsc --noEmit" },
      { name: "lint", command: "npx eslint ." },
      { name: "test", command: "npm test -- --run" },
    ]);
    expect(template("node-ts-api").manifests).toEqual(["package.json"]);
    expect(template("react-vite").gates).toEqual([
      { name: "install", command: "npm install" },
      { name: "build", command: "npm run build" },
      { name: "typecheck", command: "npx tsc -b" },
      { name: "lint", command: "npx eslint ." },
      { name: "test", command: "npm test -- --run" },
    ]);
    expect(template("react-vite").manifests).toEqual(["package.json"]);
    expect(template("python-fastapi").gates).toEqual([
      { name: "install", command: "uv sync" },
      { name: "lint", command: "uv run ruff check ." },
      { name: "typecheck", command: "uv run mypy ." },
      { name: "test", command: "uv run pytest -q" },
    ]);
    expect(template("python-fastapi").manifests).toEqual(["pyproject.toml", "uv.lock"]);
  });

  it("matches the obvious stack for each brief, best first", () => {
    expect(matchProfileTemplates("", "A TypeScript REST API")[0]?.id).toBe("node-ts-api");
    expect(matchProfileTemplates("React with Vite", "single-page web app")[0]?.id).toBe("react-vite");
    expect(matchProfileTemplates("", "FastAPI backend in Python")[0]?.id).toBe("python-fastapi");
  });

  it("orders mixed text sensibly and caps at three results", () => {
    const mixed = matchProfileTemplates("TypeScript", "a React frontend talking to a FastAPI backend");
    expect(mixed[0]?.id).toBe("react-vite");
    expect(mixed.map((t) => t.id)).toContain("python-fastapi");
    expect(mixed.length).toBeLessThanOrEqual(3);
  });

  it("returns nothing when no template fits", () => {
    expect(matchProfileTemplates("", "a beat poetry generator")).toEqual([]);
    expect(matchProfileTemplates("", "")).toEqual([]);
  });

  it("renders gate commands for matches and nothing otherwise", () => {
    const block = templatesForPrompt(matchProfileTemplates("Node.js service with a REST API", ""));
    expect(block).toContain("node-ts-api");
    expect(block).toContain("`npm install`");
    expect(block).toContain("package.json");
    expect(templatesForPrompt([])).toBe("");
  });
});

describe("normalizeProfile contracts and adrs", () => {
  it("preserves contracts and adrs, dropping non-strings and empties", () => {
    const res = normalizeProfile({
      stack: "x",
      gates: { test: "npm test" },
      manifests: ["package.json"],
      contracts: ["openapi.yaml", "", 42, null, "  types.ts  "],
      adrs: ["0001-architecture.md", "0002-storage.md", ""],
    });
    expect(res.profile?.contracts).toEqual(["openapi.yaml", "types.ts"]);
    expect(res.profile?.adrs).toEqual(["0001-architecture.md", "0002-storage.md"]);
    expect(res.profile?.manifests).toEqual(["package.json"]);
  });

  it("omits the fields when absent or empty, and keeps the test-gate error", () => {
    const bare = normalizeProfile({ stack: "x", gates: { test: "npm test" } });
    expect(bare.profile?.contracts).toBeUndefined();
    expect(bare.profile?.adrs).toBeUndefined();
    const emptyLists = normalizeProfile({ gates: { test: "npm test" }, contracts: [], adrs: [] });
    expect(emptyLists.profile?.contracts).toBeUndefined();
    expect(emptyLists.profile?.adrs).toBeUndefined();
    expect(normalizeProfile({ gates: { build: "make" } }).error).toBe('profile needs a "test" gate');
  });
});

describe("architecture prompt", () => {
  it("documents contracts, extra ADRs and the new reply fields", () => {
    const prompt = architecturePrompt({ settings: answers() });
    expect(prompt).toContain(".factory/spec/spec.md");
    expect(prompt).toContain(".factory/contracts/");
    expect(prompt).toContain("source of truth");
    expect(prompt).toContain("0002-<slug>.md");
    expect(prompt).toContain('"contracts"');
    expect(prompt).toContain('"adrs"');
    expect(prompt).not.toContain("####");
  });

  it("shows the template block only when one is provided", () => {
    const templates = templatesForPrompt(matchProfileTemplates("Node.js REST API", ""));
    const prompt = architecturePrompt({ settings: answers({ stack: "Node + TypeScript" }), specPath: ".factory/spec/spec.md", templates });
    expect(prompt).toContain("node-ts-api");
    expect(prompt).toContain("`npm install`");
    expect(prompt).toContain("start from its gates and manifests");
    const bare = architecturePrompt({ settings: answers(), specPath: ".factory/spec/spec.md" });
    expect(bare).not.toContain("node-ts-api");
  });

  it("keeps the feedback variant and points it at contracts and ADRs", () => {
    const prompt = architecturePrompt({ settings: answers(), feedback: "use Postgres" });
    expect(prompt).toContain("The user asked for changes to the architecture");
    expect(prompt).toContain("use Postgres");
    expect(prompt).toContain(".factory/contracts/");
    expect(prompt).toContain("ADR");
  });
});

describe("planning prompt", () => {
  it("lists contracts as the source of truth when provided", () => {
    const prompt = planningPrompt({ profile, contracts: ["openapi.yaml", "types.ts"] });
    expect(prompt).toContain(".factory/contracts/openapi.yaml");
    expect(prompt).toContain(".factory/contracts/types.ts");
    expect(prompt).toContain("source of truth");
    expect(prompt).toContain("Foundation tickets implement these contracts first");
    expect(prompt).toContain("build against them rather than guessing interfaces");
  });

  it("omits the contracts line when there are none", () => {
    const prompt = planningPrompt({ profile });
    expect(prompt).not.toContain(".factory/contracts/");
    expect(prompt).toContain("T-001");
  });
});
