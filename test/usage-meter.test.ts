import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { FusionEngine } from "../src/fusion/engine.js";
import { defaultFusionConfig } from "../src/shared/config.js";
import { formatMeter, hitRate, UsageMeter } from "../src/shared/usage-meter.js";
import { fakeRegistry, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("usage meter", () => {
  it("totals tokens and computes the cache hit rate over the prompt (input + cache read + cache write)", () => {
    const meter = new UsageMeter();
    meter.add(usage(1000, 200, 0, 9000, 0.05)); // cold: all written to cache
    meter.add(usage(500, 300, 9000, 500, 0.01)); // warm
    const s = meter.snapshot();
    expect(s).toMatchObject({ requests: 2, input: 1500, output: 500, cacheRead: 9000, cacheWrite: 9500, prompt: 20000 });
    expect(s.hitRate).toBeCloseTo(9000 / 20000);
    expect(s.last?.hitRate).toBeCloseTo(9000 / 10000);
    expect(s.cost).toBeCloseTo(0.06);
    expect(formatMeter(s)).toBe("2 req · ↑20.0k (1.5k new · 9.0k cache read · 9.5k cache write) · 45% cached (last 90%) · ↓500 · $0.06");
  });

  it("ignores empty usage and says when the provider reports no cache data", () => {
    const meter = new UsageMeter();
    meter.add(undefined);
    meter.add(usage(0, 0, 0, 0));
    expect(meter.snapshot().requests).toBe(0);
    expect(formatMeter(meter.snapshot())).toBe("no requests yet");
    meter.add(usage(800, 100, 0, 0));
    expect(meter.snapshot().cacheReported).toBe(false);
    expect(formatMeter(meter.snapshot())).toBe("1 req · ↑800 (no cache reported) · ↓100 · $0.00");
    expect(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });
});

describe("real-time meters in the Fusion engine", () => {
  function engineWithFaux(responses: any[]) {
    const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 128_000 }] });
    core.setResponses(responses);
    const model = core.models[0];
    const config = { ...defaultFusionConfig(), sidekick: { provider: model.provider, modelId: model.id }, sidekickTools: ["ls"] };
    const engine = new FusionEngine(recordingPi().api, fakeRegistry([model], [model], { streamSimple: core.streamSimple }), tempDir(), config);
    return engine;
  }

  it("updates the sidekick meter after every sidekick turn, while the delegation is still running", async () => {
    const seen: number[] = [];
    const engine = engineWithFaux([
      fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("ls", { path: "." }, { id: "b" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    engine.onUsage = () => seen.push(engine.meters.sidekick.snapshot().requests);
    await engine.delegate({ task: "look around" });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("reports cache reads on later delegations because the sidekick keeps a stable cache session", async () => {
    const engine = engineWithFaux([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
    await engine.delegate({ task: "first task" });
    const cold = engine.meters.sidekick.snapshot();
    expect(cold.cacheRead).toBe(0);
    expect(cold.cacheWrite).toBeGreaterThan(0);
    await engine.delegate({ task: "second task" });
    const warm = engine.meters.sidekick.snapshot();
    expect(warm.last!.cacheRead).toBeGreaterThan(0);
    expect(warm.last!.hitRate!).toBeGreaterThan(0.5);
  });

  it("records main-agent turns and shows both agents in the widget and footer", () => {
    const engine = engineWithFaux([]);
    let ticks = 0;
    engine.onUsage = () => ticks++;
    engine.recordMainUsage(usage(2000, 400, 30_000, 1000, 0.12));
    expect(ticks).toBe(1);
    const lines = engine.statusLines();
    expect(lines[0]).toMatch(/^main .* 1 req · ↑33\.0k \(2\.0k new · 30\.0k cache read · 1\.0k cache write\) · 91% cached/);
    expect(lines[1]).toMatch(/^sidekick .* no requests yet/);
    expect(engine.footerStatus()).toBe("⚛ fusion balanced · $0.12");
    expect(engine.snapshot().meters.main.requests).toBe(1);
  });
});

describe("compact widget", () => {
  function engineWith(models: any[]) {
    const core = createFauxCore({ provider: "faux", models });
    const [side, main] = core.models;
    const config = { ...defaultFusionConfig(), main: { provider: main.provider, modelId: main.id }, sidekick: { provider: side.provider, modelId: side.id } };
    const engine = new FusionEngine(recordingPi().api, fakeRegistry(core.models, core.models), tempDir(), config);
    engine.setContext({ model: main } as any);
    return engine;
  }

  it("is a single line before any requests", () => {
    const engine = engineWith([{ id: "glm-5.3-flash" }, { id: "glm-5.3" }]);
    expect(engine.compactLines()).toEqual(["⚛ fusion balanced · main glm-5.3 · side glm-5.3-flash · no requests yet"]);
  });

  it("shows ↑ input with the cached share, ↓ output and cost, one aligned line per agent", () => {
    const engine = engineWith([{ id: "glm-5.3-flash" }, { id: "glm-5.3" }]);
    engine.recordMainUsage(usage(6_200, 3_100, 412_000, 38_000, 0.61));
    engine.meters.sidekick.add(usage(2_400, 1_800, 96_000, 21_000, 0.03));
    engine.stats.delegations = 3;
    expect(engine.compactLines()).toEqual([
      "⚛ fusion balanced · 3 delegated · $0.64",
      "  main  glm-5.3        ↑456.2k  90% cached  ↓3.1k  $0.61",
      "  side  glm-5.3-flash  ↑119.4k  80% cached  ↓1.8k  $0.03",
    ]);
  });
});
