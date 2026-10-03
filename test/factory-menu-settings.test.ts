import { describe, expect, it, vi } from "vitest";
import { selectFactoryMenu } from "../src/factory/menu.js";
import { runIntegrationSetup } from "../src/factory/integration-setup.js";
import { defaultAnswers } from "../src/factory/settings.js";
import { scriptedUi } from "./factory-helpers.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getSelectListTheme: () => Object.fromEntries(["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"].map(key => [key, (text: string) => text])) }));

describe("factory menu and integration settings", () => {
  it("renders the resumed selection and handles Enter and Escape through the TUI component", async () => {
    let component: any;
    const ctx: any = { hasUI: true, mode: "tui", ui: {
      custom: vi.fn((factory: any) => new Promise(resolve => {
        component = factory({ terminal: { rows: 24 }, requestRender: vi.fn() }, { bold: (s: string) => s, fg: (_: string, s: string) => s }, {}, resolve);
      })),
      select: vi.fn(),
    } };
    const selected = selectFactoryMenu(ctx, "Settings", ["Save", "Team", "Design"], 1);
    expect(component.render(80).join("\n")).toContain("Team");
    component.handleInput("\r");
    expect(await selected).toBe("Team");
    const cancelled = selectFactoryMenu(ctx, "Settings", ["Save", "Team"], 1);
    component.handleInput("\u001b");
    expect(await cancelled).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("stages nested edits, uses exact loaded and manually entered tool names, and discards on outer Escape", async () => {
    const original = { design: { paper: { enabled: true, tools: ["original"] } }, browser: { enabled: false } };
    const script = ["paper:", "Tools:", "Select a loaded tool", "  actual_tool", "Tools:", "Enter tool names", "← Back", "Brave browser", "Enabled:", "← Back", undefined];
    const { ui } = scriptedUi({ select: (_title, options) => {
      const wanted = script.shift();
      return wanted === undefined ? undefined : options.find(option => option.startsWith(wanted));
    }, input: () => "manual_one, manual_two, manual_one" });
    expect(await runIntegrationSetup(original, ui, ["actual_tool"])).toBeUndefined();
    expect(original).toEqual({ design: { paper: { enabled: true, tools: ["original"] } }, browser: { enabled: false } });
  });

  it("saves loaded tool selection and deduplicated manual entries", async () => {
    const script = ["paper:", "Tools:", "Select a loaded tool", "  actual_tool", "← Back", "Save integrations"];
    const { ui } = scriptedUi({ select: (_title, options) => {
      const wanted = script.shift();
      return wanted === undefined ? undefined : options.find(option => option.startsWith(wanted));
    } });
    const saved = await runIntegrationSetup({}, ui, ["actual_tool"]);
    expect(saved?.design?.paper?.tools).toEqual(["actual_tool"]);
    script.push("paper:", "Tools:", "Enter tool names", "← Back", "Save integrations");
    ui.input = async () => "manual_one, manual_two, manual_one";
    expect((await runIntegrationSetup(saved, ui, []))?.design?.paper?.tools).toEqual(["manual_one", "manual_two"]);
  });

  it("normalizes project integrations while preserving global team defaults on resume", () => {
    const output = defaultAnswers({ cwd: "/nonexistent", toolNames: [], budget: { usd: 0, tokens: 0, priced: false, size: "small" }, deployTargets: [] },
      { teamPreset: "best", pins: { backend: { provider: "p", modelId: "global" } }, integrations: { browser: { enabled: true } } },
      { teamPreset: "cheap", pins: {}, integrations: { design: { paper: { tools: [" tool ", "tool"] } } } });
    expect(output.teamPreset).toBe("best");
    expect(output.pins.backend.modelId).toBe("global");
    expect(output.integrations?.design?.paper?.tools).toEqual(["tool"]);
    expect(output.integrations?.browser).toBeUndefined();
  });
});
