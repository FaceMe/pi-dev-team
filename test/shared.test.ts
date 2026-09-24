import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentDir,
  loadFusionConfig,
  loadRolesState,
  rolesPath,
  saveRolesState,
  updateFusionConfig,
} from "../src/shared/config.js";
import { findModelByRef, modelFamily } from "../src/shared/models.js";
import { assignTiers, capabilityScore } from "../src/shared/tiers.js";
import { buildTrace } from "../src/shared/trace.js";
import { contentText, excerpt, tail } from "../src/shared/text.js";
import { fakeRegistry, makeModel, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

describe("config", () => {
  it("resolves the agent dir from PI_CODING_AGENT_DIR on every call", () => {
    expect(agentDir()).toBe(agent.dir);
  });

  it("B6: loading roles never writes a file and has no hard-coded model IDs", () => {
    const state = loadRolesState();
    expect(state.roles).toEqual({});
    expect(fs.existsSync(rolesPath())).toBe(false);
  });

  it("B6: uses the settings default model without inventing roles", () => {
    fs.writeFileSync(path.join(agent.dir, "settings.json"), JSON.stringify({ defaultProvider: "p", defaultModel: "m" }));
    const state = loadRolesState();
    expect(state.defaultModel).toEqual({ provider: "p", modelId: "m" });
    expect(state.roles).toEqual({});
  });

  it("B7: fusion slots are seeded from roles, and updates preserve other keys", () => {
    saveRolesState({ roles: { frontier: { provider: "a", modelId: "big" }, small: { provider: "b", modelId: "tiny" } } });
    const config = loadFusionConfig();
    expect(config.main).toEqual({ provider: "a", modelId: "big" });
    expect(config.sidekick).toEqual({ provider: "b", modelId: "tiny" });

    updateFusionConfig({ sidekickTools: ["read"] });
    const updated = updateFusionConfig({ sidekick: { provider: "c", modelId: "mid", effort: "low" } });
    expect(updated.sidekickTools).toEqual(["read"]);
    expect(loadFusionConfig().sidekick).toEqual({ provider: "c", modelId: "mid", effort: "low" });
  });

  it("leaves fusion slots unset when there is nothing to seed from", () => {
    const config = loadFusionConfig();
    expect(config.main).toBeUndefined();
    expect(config.sidekick).toBeUndefined();
  });
});

describe("models", () => {
  it("guesses families from model names and falls back to the provider", () => {
    expect(modelFamily(makeModel({ id: "claude-x", provider: "bedrock" }))).toBe("claude");
    expect(modelFamily(makeModel({ id: "gpt-9", provider: "azure" }))).toBe("gpt");
    expect(modelFamily(makeModel({ id: "qwen3-coder", provider: "ollama" }))).toBe("qwen");
    expect(modelFamily(makeModel({ id: "house-model", provider: "acme" }))).toBe("acme");
  });

  it("finds models by provider/id, id, or case-insensitively", () => {
    const models = [makeModel({ id: "Alpha", provider: "p1" }), makeModel({ id: "beta", provider: "p2" })];
    expect(findModelByRef(models, "p1/Alpha")?.id).toBe("Alpha");
    expect(findModelByRef(models, "beta")?.provider).toBe("p2");
    expect(findModelByRef(models, "P1/ALPHA")?.id).toBe("Alpha");
    expect(findModelByRef(models, "nope")).toBeUndefined();
  });
});

describe("tiers", () => {
  const cheap = makeModel({ id: "cheap", provider: "x", cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } });
  const mid = makeModel({ id: "mid", provider: "y", reasoning: true, cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } });
  const big = makeModel({
    id: "big",
    provider: "z",
    reasoning: true,
    contextWindow: 400_000,
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
  });

  it("derives small / daily / frontier from metadata across providers", () => {
    const tiers = assignTiers(fakeRegistry([cheap, mid, big]));
    expect(tiers.frontier?.id).toBe("big");
    expect(tiers.small?.id).toBe("cheap");
    expect(tiers.daily?.id).toBe("mid");
    expect(tiers.source).toEqual({ small: "auto", daily: "auto", frontier: "auto" });
  });

  it("uses a single model for every tier and says so", () => {
    const tiers = assignTiers(fakeRegistry([mid]));
    expect([tiers.small?.id, tiers.daily?.id, tiers.frontier?.id]).toEqual(["mid", "mid", "mid"]);
    expect(tiers.notes.join(" ")).toMatch(/Only one model/);
  });

  it("ranks free/local models by capability", () => {
    const local1 = makeModel({ id: "local-small", provider: "ollama", contextWindow: 32_000 });
    const local2 = makeModel({ id: "local-big", provider: "ollama", reasoning: true, contextWindow: 128_000 });
    const tiers = assignTiers(fakeRegistry([local1, local2]));
    expect(tiers.frontier?.id).toBe("local-big");
    expect(tiers.notes.join(" ")).toMatch(/zero cost/);
  });

  it("keeps explicit role assignments from the picker", () => {
    const tiers = assignTiers(fakeRegistry([cheap, mid, big]), { frontier: { provider: "y", modelId: "mid" } });
    expect(tiers.frontier?.id).toBe("mid");
    expect(tiers.source.frontier).toBe("roles");
  });

  it("ignores roles whose model is not logged in", () => {
    const tiers = assignTiers(fakeRegistry([cheap, mid, big], [cheap, big]), { daily: { provider: "y", modelId: "mid" } });
    expect(tiers.daily?.id).not.toBe("mid");
  });

  it("reports when nothing is logged in", () => {
    const tiers = assignTiers(fakeRegistry([cheap], []));
    expect(tiers.frontier).toBeUndefined();
    expect(tiers.notes[0]).toMatch(/login/);
  });

  it("scores reasoning and context above a bare model", () => {
    expect(capabilityScore(big)).toBeGreaterThan(capabilityScore(cheap));
  });
});

describe("text and trace", () => {
  it("extracts text from string and array content", () => {
    expect(contentText("hi")).toBe("hi");
    expect(contentText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }], " ")).toBe("a b");
  });

  it("bounds excerpts and tails", () => {
    expect(excerpt("1\n2\n3\n4", 100, 2)).toMatch(/\+2 more lines/);
    expect(tail("x".repeat(50), 10).length).toBeLessThanOrEqual(11);
  });

  it("pairs tool calls with their results", () => {
    const steps = buildTrace([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file.txt" }], isError: false },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["thinking", "tool"]);
    expect(steps[1].detail).toBe("$ ls");
    expect(steps[1].output).toBe("file.txt");
  });
});
