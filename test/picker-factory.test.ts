/**
 * Factory-role picker support: role-chooser row building, factory-role
 * resolution for completed selections, and the non-TUI fallback flow behind
 * showFactoryRolePicker. Full TUI interaction is exercised manually; the
 * component itself consumes the pure helpers tested here.
 */

import { describe, expect, it } from "vitest";
import {
  buildFactoryRoleRows,
  type ModelPickerOptions,
  type ModelPickerResult,
  resolveFactoryRole,
  showFactoryRolePicker,
  showModelPicker,
  SplitModelPickerComponent,
} from "../src/picker/model-picker.js";
import { fakeRegistry, fakeUi, makeModel, recordingPi } from "./helpers.js";

// Compile-time usage: the extended option/result types must accept the new
// "factory-role" target plus the factoryRole / factoryRoles fields.
const chooserOptions: ModelPickerOptions = {
  target: "factory-role",
  factoryRoles: [{ name: "builder", description: "Writes the code" }],
};
const directOptions: ModelPickerOptions = { target: "factory-role", factoryRole: "reviewer" };
const typedResult: ModelPickerResult = {
  model: makeModel({ id: "m1", provider: "p" }),
  effort: "high",
  factoryRole: "reviewer",
};

describe("factory role typing (compile-time)", () => {
  it("accepts the extended option and result shapes", () => {
    expect(chooserOptions.target).toBe("factory-role");
    expect(directOptions.factoryRole).toBe("reviewer");
    expect(typedResult.factoryRole).toBe("reviewer");
  });
});

describe("buildFactoryRoleRows", () => {
  it("pairs each role name with its description", () => {
    const rows = buildFactoryRoleRows(
      [
        { name: "builder", description: "Writes the code" },
        { name: "reviewer" },
      ],
      80
    );
    expect(rows).toEqual([
      { name: "builder", description: "Writes the code" },
      { name: "reviewer", description: "" },
    ]);
  });

  it("truncates long descriptions so name plus description fits the row", () => {
    const rows = buildFactoryRoleRows(
      [{ name: "builder", description: "Writes code, tests and docs" }],
      15
    );
    expect(rows[0].name).toBe("builder");
    expect(rows[0].description.endsWith("...")).toBe(true);
    expect(rows[0].name.length + 1 + rows[0].description.length).toBeLessThanOrEqual(15);
  });

  it("drops the description when the name alone fills the row", () => {
    const rows = buildFactoryRoleRows(
      [{ name: "infrastructure-engineer", description: "Keeps CI green" }],
      20
    );
    expect(rows[0].name).toBe("infrastructure-engineer");
    expect(rows[0].description).toBe("");
  });

  it("returns no rows for an empty role list", () => {
    expect(buildFactoryRoleRows([], 80)).toEqual([]);
  });
});

describe("resolveFactoryRole", () => {
  it("never resolves a factory role for other targets", () => {
    for (const target of ["session", "fusion-main", "fusion-sidekick", "select"] as const) {
      expect(resolveFactoryRole({ target, factoryRole: "reviewer" })).toBeUndefined();
      expect(
        resolveFactoryRole({ target, factoryRole: "reviewer" }, { activeFactoryRole: "builder" })
      ).toBeUndefined();
    }
  });

  it("direct mode resolves to the requested role", () => {
    expect(resolveFactoryRole(directOptions)).toBe("reviewer");
  });

  it("chooser mode prefers the role chosen in this session", () => {
    expect(resolveFactoryRole(chooserOptions, { activeFactoryRole: "reviewer" })).toBe("reviewer");
  });

  it("chooser mode before a role is chosen resolves to nothing", () => {
    expect(resolveFactoryRole(chooserOptions)).toBeUndefined();
  });
});

describe("showFactoryRolePicker fallback flow (non-TUI)", () => {
  const model = makeModel({ id: "m1", provider: "p" });

  function fallbackCtx(answers: { select?: Array<string | undefined> }) {
    const { ui, selects, notes } = fakeUi(answers);
    const ctx: any = { mode: "print", ui, modelRegistry: fakeRegistry([model]) };
    return { ctx, selects, notes };
  }

  it("chooser mode asks for a role, then a model, and reports the chosen role", async () => {
    const { ctx, selects } = fallbackCtx({ select: ["reviewer - Reviews diffs", "p/m1"] });
    const out = await showFactoryRolePicker(ctx, recordingPi().api, {
      roles: [
        { name: "builder", description: "Writes the code" },
        { name: "reviewer", description: "Reviews diffs" },
      ],
    });
    expect(out?.factoryRole).toBe("reviewer");
    expect(out?.model.id).toBe("m1");
    expect(selects.map((s) => s.title)).toEqual([
      "Assign models to factory roles",
      "Model for the reviewer role",
    ]);
  });

  it("direct mode skips the role list and reports the given role", async () => {
    const { ctx, selects } = fallbackCtx({ select: ["p/m1"] });
    const out = await showFactoryRolePicker(ctx, recordingPi().api, {
      roles: [{ name: "reviewer", description: "Reviews diffs" }],
      role: "reviewer",
    });
    expect(out?.factoryRole).toBe("reviewer");
    expect(out?.model.provider).toBe("p");
    expect(selects).toHaveLength(1);
    expect(selects[0].title).toBe("Model for the reviewer role");
  });

  it("returns undefined when the role choice is cancelled", async () => {
    const { ctx } = fallbackCtx({ select: [undefined] });
    const out = await showFactoryRolePicker(ctx, recordingPi().api, {
      roles: [{ name: "builder", description: "Writes the code" }],
    });
    expect(out).toBeUndefined();
  });

  it("returns undefined when the model choice is cancelled", async () => {
    const { ctx } = fallbackCtx({ select: ["builder", undefined] });
    const out = await showFactoryRolePicker(ctx, recordingPi().api, { roles: [{ name: "builder" }] });
    expect(out).toBeUndefined();
  });

  it("never sets factoryRole for non-factory targets", async () => {
    const { ctx } = fallbackCtx({ select: ["p/m1"] });
    const out = await showModelPicker(ctx, recordingPi().api, { target: "select" });
    expect(out).toBeDefined();
    expect(out?.factoryRole).toBeUndefined();
    expect("factoryRole" in (out ?? {})).toBe(false);
  });
});

describe("persistent factory role picker", () => {
  it("returns to the chooser after assignments and model cancellation", async () => {
    const model = makeModel({ id: "m1", provider: "p" });
    const { ui, selects } = fakeUi({ select: ["builder", "p/m1", "reviewer", undefined, undefined] });
    const assigned: ModelPickerResult[] = [];
    const out = await showFactoryRolePicker({ mode: "print", ui, modelRegistry: fakeRegistry([model]) } as any, recordingPi().api, {
      roles: [{ name: "builder" }, { name: "reviewer" }],
      onAssign: (result) => assigned.push(result),
    });
    expect(out).toBeUndefined();
    expect(assigned).toHaveLength(1);
    expect(assigned[0].factoryRole).toBe("builder");
    expect(selects.map((s) => s.title)).toEqual([
      "Assign models to factory roles", "Model for the builder role", "Assign models to factory roles",
      "Model for the reviewer role", "Assign models to factory roles",
    ]);
    expect(selects[2].options[0]).toContain("p/m1");
  });

  it("renders the current assignment alongside the role description", () => {
    expect(buildFactoryRoleRows([{ name: "builder", description: "Writes code", assignment: { provider: "p", modelId: "m1", effort: "high" } }], 80)).toEqual([
      { name: "builder", description: "p/m1 · high — Writes code" },
    ]);
  });
});


describe("factory role picker TUI navigation", () => {
  it("retains selected role after save and cancel, and exits from role chooser", () => {
    const model = makeModel({ id: "m1", provider: "p" });
    const done: unknown[] = [];
    const assigned: ModelPickerResult[] = [];
    const component = new SplitModelPickerComponent(
      { requestRender() {} } as any, {} as any, (result) => done.push(result),
      { mode: "tui", modelRegistry: fakeRegistry([model]) } as any, { ...recordingPi().api, getThinkingLevel: () => "off" },
      { target: "factory-role", factoryRoles: [{ name: "builder" }, { name: "reviewer" }], onFactoryAssign: (result) => assigned.push(result) },
    );
    component.handleInput("\x1b[B"); // Select reviewer.
    component.handleInput("\r"); // Role -> models.
    component.handleInput("\r"); // Assign -> same role row.
    expect(assigned.map((result) => result.factoryRole)).toEqual(["reviewer"]);
    expect(done).toEqual([]);
    component.handleInput("\r");
    component.handleInput("\x1b"); // Cancel model selection -> role row.
    expect(done).toEqual([]);
    component.handleInput("\r");
    component.handleInput("\r");
    expect(assigned.map((result) => result.factoryRole)).toEqual(["reviewer", "reviewer"]);
    component.handleInput("\x1b");
    expect(done).toEqual([null]);
  });
});
