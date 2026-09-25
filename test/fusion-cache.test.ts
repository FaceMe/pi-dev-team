import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { compactTranscript, FusionEngine } from "../src/fusion/engine.js";
import fusionExtension from "../src/fusion/extension.js";
import { PiSubprocessRunner } from "../src/factory/runner.js";
import { defaultFusionConfig, loadFusionConfig, saveFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

function sidekickEngine(opts: { contextWindow?: number; promptCache?: any; responses?: number; config?: any } = {}) {
  const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: opts.contextWindow ?? 128_000 }] });
  core.setResponses(Array.from({ length: opts.responses ?? 30 }, (_, i) => fauxAssistantMessage([fauxText(`result ${i} `.repeat(40))])));
  const model: any = { ...core.models[0], ...(opts.promptCache ? { promptCache: opts.promptCache } : {}) };
  const seenOptions: any[] = [];
  const streamSimple = (m: any, ctx: any, options: any) => {
    seenOptions.push(options);
    return core.streamSimple(m, ctx, options);
  };
  const engine = new FusionEngine(recordingPi().api, fakeRegistry([model], [model], { streamSimple }), tempDir(), {
    ...defaultFusionConfig(),
    sidekick: { provider: model.provider, modelId: model.id },
    sidekickTools: [],
    ...(opts.config ?? {}),
  });
  return { engine, seenOptions };
}

describe("sidekick cache", () => {
  it("keeps the cache warm across 30 delegations (no periodic trim)", async () => {
    const { engine } = sidekickEngine();
    const hits: number[] = [];
    for (let i = 0; i < 30; i++) {
      await engine.delegate({ task: `task ${i}: ${"details ".repeat(30)}` });
      hits.push(engine.meters.sidekick.snapshot().last!.hitRate ?? 0);
    }
    expect(hits[0]).toBe(0);
    expect(Math.min(...hits.slice(1))).toBeGreaterThan(0.4);
    expect(engine.stats.sidekickCompactions).toBe(0);
  });

  it("compacts only when the prompt fills the context window, with a summary, and the cache recovers", async () => {
    const { engine } = sidekickEngine({ contextWindow: 3000 });
    const hits: number[] = [];
    for (let i = 0; i < 12; i++) {
      await engine.delegate({ task: `task ${i}: ${"details ".repeat(30)}` });
      hits.push(engine.meters.sidekick.snapshot().last!.hitRate ?? 0);
    }
    expect(engine.stats.sidekickCompactions).toBeGreaterThan(0);
    const first = (engine as any).agent.state.messages[0];
    expect(String(first.content)).toContain("Summary of earlier delegations");
    expect(String(first.content)).toMatch(/- task 0: .* → result 0/);
    // after the cold request that follows a compaction, hits come back
    expect(hits.at(-1)!).toBeGreaterThan(0.3);
  });

  it("asks for long retention when the model declares a long cache lifetime", async () => {
    const saved = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
    try {
      const long = sidekickEngine({ promptCache: { short: 300, long: 3600 } });
      await long.engine.delegate({ task: "x" });
      expect(long.seenOptions[0].cacheRetention).toBe("long");

      const plain = sidekickEngine();
      await plain.engine.delegate({ task: "x" });
      expect(plain.seenOptions[0].cacheRetention).toBeUndefined();

      const forced = sidekickEngine({ config: { cache: { sidekickRetention: "short" } }, promptCache: { long: 3600 } });
      await forced.engine.delegate({ task: "x" });
      expect(forced.seenOptions[0].cacheRetention).toBe("short");

      process.env.PI_CACHE_RETENTION = "short";
      const env = sidekickEngine({ promptCache: { long: 3600 } });
      await env.engine.delegate({ task: "x" });
      expect(env.seenOptions[0].cacheRetention).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = saved;
    }
  });

  it("summaries carry over across repeated compactions", () => {
    const brief = (i: number) => ({ role: "user", content: `## Task\ntask ${i}\n\nmore` });
    const answer = (i: number) => ({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
    let messages: any[] = [];
    for (let i = 0; i < 6; i++) messages.push(brief(i), answer(i));
    messages = compactTranscript(messages)!;
    for (let i = 6; i < 12; i++) messages.push(brief(i), answer(i));
    messages = compactTranscript(messages)!;
    const note = String(messages[0].content);
    expect(note).toContain("- task 0 → answer 0");
    expect(note).toContain("- task 6 → answer 6");
    expect(note.match(/Summary of earlier delegations/g)).toHaveLength(1);
  });

  it("migrates the old maxMessages default of 40", () => {
    saveFusionConfig({ ...defaultFusionConfig(), limits: { maxTurns: 12, maxMessages: 40 } as any });
    expect(loadFusionConfig().limits).toMatchObject({ maxMessages: 400, maxContextFraction: 0.5 });
  });
});

describe("main agent prompt stability", () => {
  function boot(started: boolean) {
    const core = createFauxCore({ provider: "faux", models: [{ id: "cheap-model", contextWindow: 128_000 }, { id: "big", reasoning: true, contextWindow: 200_000 }] });
    const [cheap, big] = core.models;
    saveFusionConfig({
      ...defaultFusionConfig(),
      main: { provider: big.provider, modelId: big.id },
      sidekick: { provider: cheap.provider, modelId: cheap.id },
      routing: { ...defaultFusionConfig().routing, enabled: false },
    });
    const rec = recordingPi();
    rec.activeTools = ["read", "bash", "edit", "write"];
    fusionExtension(rec.api);
    const { ui } = fakeUi();
    const ctx: any = {
      hasUI: true,
      ui,
      cwd: tempDir(),
      model: big,
      modelRegistry: fakeRegistry([cheap, big], [cheap, big], { streamSimple: core.streamSimple }),
      sessionManager: { getBranch: () => (started ? [{ type: "message", message: { role: "user", content: "hi" } }] : []) },
    };
    const fire = async (event: string, payload: any) => {
      let result: any;
      for (const handler of rec.handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
      return result;
    };
    const section = async () => {
      const options: any = { sections: {} };
      await fire("before_agent_start", { systemPromptOptions: options });
      return String(options.sections.fusion);
    };
    return { rec, ctx, fire, section };
  }

  it("does not name the sidekick model in the main prompt", async () => {
    const { fire, section } = boot(true);
    await fire("session_start", {});
    expect(await section()).not.toContain("cheap-model");
  });

  it("enforces a mode change immediately but changes the prompt and tools only at compaction", async () => {
    const { rec, ctx, fire, section } = boot(true);
    await fire("session_start", {});
    expect(await section()).toContain("Mode: BALANCED");
    await rec.commands.get("fusion").handler("mode strict", ctx);
    // enforcement: live
    expect((await fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls" } })).block).toBe(true);
    // prompt and tools: unchanged until compaction
    expect(await section()).toContain("Mode: BALANCED");
    expect(rec.activeTools).toContain("bash");
    await fire("session_compact", {});
    expect(await section()).toContain("Mode: STRICT");
    expect(rec.activeTools).not.toContain("bash");
  });

  it("applies a mode change to the prompt at once before the conversation starts", async () => {
    const { rec, ctx, fire, section } = boot(false);
    await fire("session_start", {});
    await rec.commands.get("fusion").handler("mode strict", ctx);
    expect(await section()).toContain("Mode: STRICT");
    expect(rec.activeTools).not.toContain("bash");
  });
});

describe("factory workers", () => {
  it("run with long prompt-cache retention unless the user set one", async () => {
    const dir = tempDir("fake-pi-");
    const script = path.join(dir, "fake-pi.mjs");
    fs.writeFileSync(
      script,
      `const text = "retention=" + (process.env.PI_CACHE_RETENTION ?? "unset");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } }));`,
    );
    const member = { role: "backend", provider: "p", modelId: "m", tier: "daily" as const, family: "x" };
    const request = { role: "backend", member, tools: [], systemPrompt: "s", prompt: "p", cwd: dir, sessionId: "s1", sessionDir: path.join(dir, "s"), writeScope: [] };
    const env = { ...process.env };
    delete env.PI_CACHE_RETENTION;
    const defaulted = await new PiSubprocessRunner({ ...env, PI_FACTORY_PI_BIN: script }).run(request);
    expect(defaulted.text).toBe("retention=long");
    const explicit = await new PiSubprocessRunner({ ...env, PI_FACTORY_PI_BIN: script, PI_CACHE_RETENTION: "short" }).run(request);
    expect(explicit.text).toBe("retention=short");
  });
});
