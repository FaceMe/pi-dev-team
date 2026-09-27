import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { changeSummary, formatAcceptance, formatChecks, parseAcceptance, runCheck } from "../src/fusion/checks.js";
import { DEFAULT_DELEGATION, isReadOnlyInspection } from "../src/fusion/policy.js";
import fusionExtension from "../src/fusion/extension.js";
import { defaultFusionConfig, saveFusionConfig } from "../src/shared/config.js";
import { fakeRegistry, fakeUi, recordingPi, tempDir, useTempAgentDir } from "./helpers.js";

let agent: ReturnType<typeof useTempAgentDir>;
beforeEach(() => {
  agent = useTempAgentDir();
});
afterEach(() => agent.restore());

const node = (code: string) => `"${process.execPath}" -e "${code}"`;

describe("harness checks", () => {
  it("reports the real exit code, duration and output tail", async () => {
    const ok = await runCheck(node("console.log('12 passed')"), tempDir(), 30);
    expect(ok).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(ok.tail).toContain("12 passed");

    const bad = await runCheck(node("console.error('boom at a.ts:3'); process.exit(3)"), tempDir(), 30);
    expect(bad).toMatchObject({ passed: false, exitCode: 3 });
    expect(formatChecks([ok, bad])).toMatch(/✓ .* exit 0[\s\S]*✗ .* exit 3[\s\S]*boom at a\.ts:3/);
  });

  it("times out, and refuses commands that never exit", async () => {
    const slow = await runCheck(node("setTimeout(() => {}, 10000)"), tempDir(), 1);
    expect(slow).toMatchObject({ passed: false, timedOut: true });
    expect(slow.durationMs).toBeLessThan(5000);
    const dev = await runCheck("npm run dev", tempDir(), 30);
    expect(dev.passed).toBe(false);
    expect(dev.refused).toMatch(/does not exit/);
  });

  it("keeps the full output in a log when the tail is shorter", async () => {
    const noisy = await runCheck(node("for (let i = 0; i < 200; i++) console.log('line ' + i); process.exit(1)"), tempDir(), 30);
    expect(noisy.tail.split("\n")).toHaveLength(40);
    expect(fs.readFileSync(noisy.logPath!, "utf8")).toContain("line 0\n");
  });
});

describe("acceptance tally", () => {
  const criteria = ["empty input returns null", "existing tests still pass", "no new dependencies"];

  it("reads the sidekick's checklist; the last answer per criterion wins", () => {
    const text = [
      "Did the thing.",
      "- [ ] 1 — draft",
      "## Acceptance",
      "- [x] 1 — parser.test.ts:40 passes",
      "- [ ] 2: 1 failure in date.test.ts",
    ].join("\n");
    const report = parseAcceptance(text, criteria);
    expect(report.criteria.map((c) => c.state)).toEqual(["met", "unmet", "unreported"]);
    expect(report.met).toBe(1);
    const formatted = formatAcceptance(report);
    expect(formatted).toContain("1/3 met");
    expect(formatted).toContain("? 3. no new dependencies — not answered");
  });
});

describe("read-only inspection", () => {
  it("allows git inspection and text tools, never writes or chained commands", () => {
    for (const cmd of ["git diff", "git --no-pager log -3", "git show HEAD:a.ts | head -40", "git diff 2>&1 | tail -20", "grep -rn x src | sort | uniq -c", "git branch --show-current"]) {
      expect(isReadOnlyInspection(cmd), cmd).toBe(true);
    }
    for (const cmd of ["git diff > p", "git log; rm x", "git status & rm x", "git log\nrm x", "git checkout .", "git branch -D x", "sort -o f", "cat $(x)", "echo x > f", "git grep -O vi x", "rg --pre sh x"]) {
      expect(isReadOnlyInspection(cmd), cmd).toBe(false);
    }
  });
});

describe("change summary", () => {
  it("counts lines per file from git and marks untracked files new", async () => {
    const dir = tempDir();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    fs.writeFileSync(path.join(dir, "a.ts"), "one\n");
    git("add", "a.ts");
    git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "a");
    fs.writeFileSync(path.join(dir, "a.ts"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "new\n");
    const changes = await changeSummary([path.join(dir, "a.ts"), "b.ts"], dir);
    expect(changes).toEqual([{ file: "a.ts", added: 2, removed: 0 }, { file: "b.ts", isNew: true }]);
  });
});

describe("fusion extension: spec, verdicts, review", () => {
  function boot(mode: "strict" | "balanced", responses: Array<string | object | ((context: any) => any)>) {
    const core = createFauxCore({ provider: "faux", models: [{ id: "cheap", contextWindow: 128_000 }, { id: "big", reasoning: true, contextWindow: 200_000 }] });
    core.setResponses(responses.map((r) => (typeof r === "string" ? fauxAssistantMessage([fauxText(r)]) : r)) as any);
    const [cheap, big] = core.models;
    saveFusionConfig({
      ...defaultFusionConfig(),
      main: { provider: big.provider, modelId: big.id },
      sidekick: { provider: cheap.provider, modelId: cheap.id },
      routing: { ...defaultFusionConfig().routing, enabled: false, escalateOnFailure: false },
      delegation: { ...DEFAULT_DELEGATION, mode, editNudgeFiles: 3 },
      sidekickTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    const rec = recordingPi();
    rec.activeTools = ["read", "bash", "edit", "write"];
    fusionExtension(rec.api);
    const { ui } = fakeUi();
    const ctx: any = { hasUI: true, ui, cwd: tempDir(), model: big, modelRegistry: fakeRegistry([cheap, big], [cheap, big], { streamSimple: core.streamSimple }), sessionManager: { getBranch: () => [] } };
    const fire = async (event: string, payload: any) => {
      let result: any;
      for (const handler of rec.handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
      return result;
    };
    const delegate = (params: Record<string, unknown>) => rec.tools.get("sidekick").execute("c", params, undefined, undefined, ctx);
    return { rec, ctx, fire, delegate };
  }

  it("puts acceptance criteria and the harness's checks into the brief", async () => {
    let brief = "";
    const { fire, delegate } = boot("balanced", [
      (context: any) => {
        brief = JSON.stringify(context.messages.at(-1)?.content ?? "");
        return fauxAssistantMessage([fauxText("done\n## Acceptance\n- [x] 1 — ok")]);
      },
    ]);
    await fire("session_start", {});
    await delegate({ task: "fix it", acceptance: ["empty input returns null"], verify: ["npm test -- parser"] });
    expect(brief).toContain("## Acceptance criteria");
    expect(brief).toContain("1. empty input returns null");
    expect(brief).toContain("npm test -- parser");
  });

  it("prefixes a PASSED verdict when checks pass and every criterion is met", async () => {
    const { fire, delegate } = boot("balanced", ["fixed\n## Acceptance\n- [x] 1 — a.test.ts passes"]);
    await fire("session_start", {});
    const result = await delegate({ task: "fix", acceptance: ["a works"], verify: [node("console.log('1 passed')")] });
    const text = result.content[0].text as string;
    expect(text).toMatch(/^\[fusion\] verdict: PASSED \(checks 1\/1 passed · acceptance 1\/1 met\)/);
    expect(text).toContain("1 passed");
    expect(result.details.verdict).toBe("passed");
  });

  it("rejects a result whose check fails even when the sidekick claims success", async () => {
    const { fire, delegate, rec, ctx } = boot("balanced", ["all tests pass!\n## Acceptance\n- [x] 1 — done"]);
    await fire("session_start", {});
    const result = await delegate({ task: "fix", acceptance: ["tests pass"], verify: [node("console.error('FAIL a.test.ts'); process.exit(1)")] });
    const text = result.content[0].text as string;
    expect(text).toMatch(/^\[fusion\] verdict: FAILED/);
    expect(text).toContain("FAIL a.test.ts");
    expect(result.details.verdict).toBe("failed");
    await rec.commands.get("fusion").handler("stats", ctx);
  });

  it("strict mode: two failed delegations hand the execution tools back until the next prompt after a success", async () => {
    const failing = [node("process.exit(1)")];
    const { fire, delegate, rec } = boot("strict", ["tried", "tried again", "fixed", "ok"]);
    await fire("session_start", {});
    expect(rec.activeTools).not.toContain("edit");

    await delegate({ task: "fix", verify: failing });
    expect(rec.activeTools).not.toContain("edit");
    const second = await delegate({ task: "fix", verify: failing });
    expect(second.content[0].text).toMatch(/strict mode is relaxed/);
    expect(rec.activeTools).toEqual(expect.arrayContaining(["edit", "write"]));
    expect(await fire("tool_call", { toolName: "edit", toolCallId: "e", input: { path: "a.ts" } })).toBeUndefined();

    // A success does not flip tools mid-run (that would thrash the cache)...
    await delegate({ task: "fix", verify: [node("process.exit(0)")] });
    expect(rec.activeTools).toContain("edit");
    // ...strict returns with the next user prompt.
    await fire("before_agent_start", { systemPromptOptions: { sections: {} } });
    expect(rec.activeTools).not.toContain("edit");
    expect((await fire("tool_call", { toolName: "edit", toolCallId: "e2", input: { path: "a.ts" } })).block).toBe(true);
  });

  it("asks the main agent once to review files the sidekick changed before the run ends", async () => {
    const { fire, delegate } = boot("balanced", [
      fauxAssistantMessage([fauxToolCall("write", { path: "src/out.ts", content: "export const x = 1;\n" }, { id: "w1" })], { stopReason: "toolUse" }),
      "wrote src/out.ts",
    ]);
    await fire("session_start", {});
    await fire("before_agent_start", { systemPromptOptions: { sections: {} } });
    const result = await delegate({ task: "write out.ts" });
    expect(result.content[0].text).toContain("## Files the sidekick changed");
    const gate = await fire("agent_before_settle", { outcome: "completed" });
    expect(gate.continue).toBe(true);
    expect(gate.entries[0].content).toMatch(/Review before you finish[\s\S]*src\/out\.ts/);
    expect(await fire("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it("does not ask for a review the main agent already did", async () => {
    const { fire, delegate } = boot("balanced", [
      fauxAssistantMessage([fauxToolCall("write", { path: "src/out.ts", content: "x\n" }, { id: "w1" })], { stopReason: "toolUse" }),
      "wrote it",
    ]);
    await fire("session_start", {});
    await fire("before_agent_start", { systemPromptOptions: { sections: {} } });
    await delegate({ task: "write out.ts" });
    await fire("tool_call", { toolName: "bash", toolCallId: "g", input: { command: "git diff -- src/out.ts" } });
    expect(await fire("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it("balanced: nudges once after many direct edits in one run", async () => {
    const { fire } = boot("balanced", []);
    await fire("session_start", {});
    await fire("before_agent_start", { systemPromptOptions: { sections: {} } });
    const nudges: string[] = [];
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await fire("tool_call", { toolName: "edit", toolCallId: file, input: { path: file } });
      const result = await fire("tool_result", { toolName: "edit", toolCallId: file, input: { path: file }, content: [{ type: "text", text: "ok" }], isError: false });
      nudges.push(...(result?.content ?? []).map((p: any) => p.text).filter((t: string) => t.includes("edited")));
    }
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatch(/edited 3 files directly/);
  });
});
