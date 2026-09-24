/** Scripted behaviour for each factory role, for a mock OpenAI-compatible model. */

import type { MockReply } from "./mock-openai.js";

const fence = (v: unknown) => "```json\n" + JSON.stringify(v) + "\n```";

type Action = MockReply;

/** What each role does, keyed by a phrase from its system prompt. */
export function script(system: string, prompt: string): Action[] {
  if (system.includes("product analyst")) {
    if (prompt.includes("interview round")) return [{ text: fence({ ready: true, questions: [] }) }];
    return [
      { tool: "write", args: { path: ".factory/spec/spec.md", content: "# Spec\n\n- FR-001 add(a, b) returns the sum.\n  - Given 1 and 2 When add is called Then it returns 3\n" } },
      { tool: "write", args: { path: ".factory/spec/assumptions.md", content: "- Plain JavaScript module\n" } },
      { text: "Spec written." },
    ];
  }
  if (system.includes("software architect")) {
    return [
      { tool: "write", args: { path: ".factory/adr/0001-architecture.md", content: "# ADR 1\n\nNode 22 ES modules, node:test.\n" } },
      { text: fence({ stack: "Node 22 + node:test", gates: { install: "true", test: "node --test" }, manifests: ["package.json"] }) },
    ];
  }
  if (system.includes("technical planner")) {
    return [
      {
        text: fence({
          tickets: [
            { id: "T-001", title: "Add add()", role: "backend", dependsOn: [], requirements: ["FR-001"], brief: "Create src/add.js exporting add(a,b) with a test.", acceptance: ["Given 1 and 2 When add Then 3"], writeScope: ["src/**", "test/**"] },
          ],
        }),
      },
    ];
  }
  if (system.includes("DevOps engineer")) {
    return [
      { tool: "write", args: { path: "package.json", content: JSON.stringify({ name: "demo", type: "module" }) } },
      { tool: "write", args: { path: "test/smoke.test.js", content: "import test from 'node:test';\ntest('smoke', () => {});\n" } },
      { tool: "write", args: { path: ".gitignore", content: "node_modules/\n.factory/\n" } },
      { text: "Skeleton ready." },
    ];
  }
  if (system.includes("senior backend engineer")) {
    return [
      { tool: "write", args: { path: "test/add.test.js", content: "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/add.js';\ntest('add', () => assert.equal(add(1, 2), 3));\n" } },
      // Out of scope: must be blocked by the worker guard.
      { tool: "write", args: { path: "package.json", content: "{\"broken\": true}" } },
      { tool: "write", args: { path: "src/add.js", content: "export const add = (a, b) => a + b;\n" } },
      { text: "Implemented add() with a test." },
    ];
  }
  if (system.includes("code reviewer")) return [{ text: fence({ verdict: "approve", findings: [] }) }];
  if (system.includes("technical writer")) {
    return [
      { tool: "write", args: { path: "README.md", content: "# Demo\n\n`node --test`\n" } },
      { text: "Docs written." },
    ];
  }
  return [{ text: "ok" }];
}


/** Mock responder: picks the role from the system prompt and advances one action per assistant turn. */
export function roleResponder(messages: any[]): MockReply {
  const system = String(messages.find((m: any) => m.role === "system" || m.role === "developer")?.content ?? "");
  let lastUser = -1;
  messages.forEach((m: any, i: number) => {
    if (m.role === "user") lastUser = i;
  });
  const prompt = typeof messages[lastUser]?.content === "string" ? messages[lastUser].content : JSON.stringify(messages[lastUser]?.content ?? "");
  const done = messages.slice(lastUser + 1).filter((m: any) => m.role === "assistant").length;
  const actions = script(system, prompt);
  return actions[Math.min(done, actions.length - 1)];
}
