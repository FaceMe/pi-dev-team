import { describe, expect, it, vi } from "vitest";
import { BACK, runQuickSetup, runRoleSetup, SAVE_SETTINGS, START, type SetupDeps } from "../src/factory/setup.js";
import type { SetupAnswers } from "../src/factory/types.js";
import { scriptedUi } from "./factory-helpers.js";

function initial(): SetupAnswers {
  return { teamPreset: "balanced", pins: {}, autonomy: "balanced", projectMode: "new", stack: "auto", research: "off", deploy: "none", budgetUsd: 0, budgetTokens: 0 };
}
function deps(script: Array<string | undefined>, pickModel = vi.fn(async () => ({ provider: "p", modelId: "chosen" } as any))): SetupDeps {
  const { ui } = scriptedUi({ select: (_title, options) => {
    const wanted = script.shift();
    return wanted === undefined ? undefined : options.find((option) => option.startsWith(wanted));
  } });
  return {
    ui, pickModel, roles: ["backend", "frontend", "reviewer"],
    roleGroups: [{ label: "builders", roles: ["backend", "frontend"] }],
    deployTargets: [], webAccessInstalled: false,
    budgetEstimate: { usd: 0, tokens: 0, priced: false, size: "small" },
    previewTeam: (answers) => ({ members: Object.fromEntries(["backend", "frontend", "reviewer"].map((role) => [role, Object.assign({ role, tier: "daily", family: "test", provider: "p", modelId: "default", effort: "medium" }, answers.pins[role])])), tiers: {}, notes: [] }) as any,
  };
}

describe("factory settings navigation", () => {
  it("saves settings without offering Start", async () => {
    const d = deps([SAVE_SETTINGS]);
    d.mode = "settings";
    const select = vi.spyOn(d.ui, "select");
    expect(await runQuickSetup(initial(), d)).toEqual(initial());
    expect(select.mock.calls[0][1]).toContain(SAVE_SETTINGS);
    expect(select.mock.calls[0][1]).not.toContain(START);
  });

  it("picker save and cancel return to role list, then Team and settings", async () => {
    const pick = vi.fn().mockResolvedValueOnce({ provider: "p", modelId: "new", effort: "high" }).mockResolvedValueOnce(undefined);
    const d = deps(["Team:", "configure role", "backend:", "frontend:", undefined, undefined, SAVE_SETTINGS], pick);
    d.mode = "settings";
    const select = vi.spyOn(d.ui, "select");
    const output = await runQuickSetup(initial(), d);
    expect(output?.pins.backend.modelId).toBe("new");
    expect(output?.pins.frontend).toBeUndefined();
    expect(pick.mock.calls[0][1]).toMatchObject({ modelId: "default", effort: "medium" });
    expect(select.mock.calls.map((call) => call[0])).toEqual([
      "Factory settings — Save settings when finished", "Team",
      "Role models — Enter configures; Esc returns to Team",
      "Role models — Enter configures; Esc returns to Team",
      "Role models — Enter configures; Esc returns to Team", "Team",
      "Factory settings — Save settings when finished",
    ]);
    expect(select.mock.calls[3][1][0]).toContain("p/new · high (pinned)");
    expect(select.mock.calls[4][2]).toEqual({ initialIndex: 1 });
    expect(select.mock.calls[6][2]).toEqual({ initialIndex: 1 });
  });

  it("stages integration saves and preserves the row after nested cancellation", async () => {
    const answers = initial();
    answers.integrations = { browser: { enabled: false } };
    const d = deps(["Design/browser:", "Design/browser:", SAVE_SETTINGS]);
    d.mode = "settings";
    d.configureIntegrations = vi.fn().mockImplementationOnce(async (current) => {
      current.browser.enabled = true;
      return undefined;
    }).mockResolvedValueOnce({ browser: { enabled: true } });
    const select = vi.spyOn(d.ui, "select");
    const output = await runQuickSetup(answers, d);
    expect(output?.integrations?.browser?.enabled).toBe(true);
    expect(answers.integrations.browser?.enabled).toBe(false);
    expect(select.mock.calls[1][1].at(-1)).toContain("Brave QA off");
    expect(select.mock.calls[1][2]).toEqual({ initialIndex: 8 });
  });

  it("bulk assigns all roles, then updates only the chosen group", async () => {
    const pick = vi.fn().mockResolvedValueOnce({ provider: "p", modelId: "all" }).mockResolvedValueOnce({ provider: "p", modelId: "builders" });
    const output = await runRoleSetup(initial(), deps(["Assign all", "Assign builders", SAVE_SETTINGS], pick));
    expect(Object.values(output!.pins).map((pin) => pin.modelId)).toEqual(["builders", "builders", "all"]);
    expect(output!.pins.backend).not.toBe(output!.pins.frontend);
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("discards staged role changes on cancellation", async () => {
    const answers = initial();
    expect(await runRoleSetup(answers, deps(["backend:", undefined]))).toBeUndefined();
    expect(answers.pins).toEqual({});
  });

  it("returns to Team after clearing pins and retains preset edits", async () => {
    const answers = initial();
    answers.pins.backend = { provider: "p", modelId: "pinned" };
    const output = await runQuickSetup(answers, deps(["Team:", "clear pinned", "best", BACK, START]));
    expect(output?.pins).toEqual({});
    expect(output?.teamPreset).toBe("best");
    expect(answers.pins.backend.modelId).toBe("pinned");
  });
});
