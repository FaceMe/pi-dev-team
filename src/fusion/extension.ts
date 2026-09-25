/**
 * pi-fusion — hybrid main/sidekick model harness for the pi coding agent.
 * The engine lives in engine.ts; this file wires tools, events, commands, the
 * menu wizard and transcript renderers.
 *
 * State:
 *   <agentDir>/fusion.json        — configuration (main/sidekick slots, routing, limits)
 *   <agentDir>/fusion-stats.json  — lifetime cost/savings ledger
 *   <agentDir>/model-roles.json   — read for defaults (frontier -> main, small -> sidekick)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, modelsAreEqual, StringEnum } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { classifyCommand, decideDirectCall, EXECUTION_TOOLS, nudgeText, recordCommand } from "./policy.js";
import type { DelegationMode, PolicyState } from "./policy.js";
import {
  DEFAULT_FUSION_SHORTCUT,
  FUSION_CONFIG_EVENT,
  fusionConfigPath,
  loadFusionConfig,
  saveFusionConfig,
} from "../shared/config.js";
import type { FusionConfig, FusionRoutingConfig } from "../shared/config.js";
import { clampEffort, findModelByRef, modelKey } from "../shared/models.js";
import type { EffortLevel } from "../shared/models.js";
import { truncate } from "../shared/text.js";
import { renderTraceSteps } from "../shared/trace.js";
import type { DelegationTrace, TraceStep } from "../shared/trace.js";
import { addUsage, formatCost } from "../shared/usage.js";
import { showModelPicker } from "../picker/model-picker.js";
import {
  buildMainGuidance,
  buildTranscript,
  EXTENSION_TAG,
  FusionEngine,
  restoreRoutedSidekick,
} from "./engine.js";
import type { BackgroundTask, DelegationOutcome, FusionStats, LifetimeStats, RouteRecord } from "./engine.js";

/** Effective Fusion menu shortcut. Falls back to the default when unset or blank. */
export function resolveFusionShortcut(config: FusionConfig): string {
  const raw = typeof config.shortcut === "string" ? config.shortcut.trim().toLowerCase() : "";
  return raw.length > 0 ? raw : DEFAULT_FUSION_SHORTCUT;
}

/**
 * Inside a factory worker process (a `pi` subprocess started by the factory),
 * Fusion stays off unless the worker's role asked for its own sidekick.
 */
export function fusionAllowedInProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_FACTORY_WORKER !== "1") return true;
  return env.PI_FACTORY_SIDEKICK === "1";
}

const CONFIG_PATH_HINT = () => fusionConfigPath();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fusionExtension(pi: ExtensionAPI) {
  let config = loadFusionConfig();
  let engine: FusionEngine | undefined;
  let userPickedModel = false;
  let internalModelChange = false;
  /** Session model active before fusion took over the main slot, for restore on /fusion off. */
  let preFusionModel: Model<any> | undefined;
  const allowed = fusionAllowedInProcess();

  // Registration methods are the only API calls allowed while the extension is
  // still loading, so tool/action lookups are deferred to session_start.
  const toolName = "sidekick";
  // Embedded in the tool description below, so the collision check at
  // session_start can recognise Fusion's own tool.
  const TOOL_MARKER = "Fusion sidekick";

  const isActive = (): boolean => allowed && config.enabled;

  const persistConfig = (): void => {
    saveFusionConfig(config);
    pi.events?.emit(FUSION_CONFIG_EVENT, config);
  };

  /** Run a model switch that fusion itself initiates, so it doesn't count as a user pick. */
  const internalSetModel = async (model: Model<any>): Promise<boolean> => {
    internalModelChange = true;
    try {
      return await pi.setModel(model);
    } finally {
      internalModelChange = false;
    }
  };

  // Another extension (the model picker) changed fusion.json: pick up its slots.
  pi.events?.on(FUSION_CONFIG_EVENT, (updated: any) => {
    if (!updated || typeof updated !== "object" || updated === config) return;
    let changed = false;
    const same = (a: any, b: any) =>
      a?.provider === b?.provider && a?.modelId === b?.modelId && a?.effort === b?.effort;
    if (updated.main && !same(updated.main, config.main)) {
      config.main = { ...updated.main };
      changed = true;
    }
    if (updated.sidekick && !same(updated.sidekick, config.sidekick)) {
      config.sidekick = { ...updated.sidekick };
      const sidekickModel = engine?.resolveSidekickModel();
      // A deliberate choice, not a routing decision: don't record it in the session.
      if (engine && sidekickModel) engine.setSidekickModel(sidekickModel, config.sidekick?.effort);
      changed = true;
    }
    if (changed) {
      if (engine) engine.config = config;
      refreshUi();
    }
  });

  const refreshUi = (ctx?: ExtensionContext): void => {
    const target = ctx ?? engine?.latestCtx;
    if (!engine || !target || !target.hasUI) return;
    try {
      target.ui.setStatus(EXTENSION_TAG, engine.footerStatus());
      target.ui.setWidget(EXTENSION_TAG, engine.statusLines());
    } catch {
      /* UI may be unavailable */
    }
  };

  const waitToolName = `${toolName}_wait`;
  /** Execution tools removed from the main agent by strict mode, to restore later. */
  let strictRemoved: string[] = [];
  const policy: PolicyState = { directStreak: 0, failedDelegations: 0, history: new Map() };
  /** Start times of the main agent's test/build/install commands, by tool call id. */
  const commandStarts = new Map<string, { command: string; at: number }>();
  /** Files the main agent has read recently (newest last), for sidekick briefs. */
  let recentReads: string[] = [];

  const noteRead = (input: Record<string, unknown>): void => {
    const target = String(input.path ?? input.file_path ?? "").trim();
    if (!target) return;
    const range =
      input.offset !== undefined || input.limit !== undefined
        ? ` (lines ${Number(input.offset ?? 1)}–${input.limit !== undefined ? Number(input.offset ?? 1) + Number(input.limit) - 1 : "end"})`
        : "";
    const entry = `${target}${range}`;
    recentReads = [...recentReads.filter((r) => r !== entry), entry].slice(-15);
  };

  const gitStatus = (cwd: string): Promise<string> =>
    new Promise((resolve) => {
      execFile("git", ["status", "--short", "--branch"], { cwd, timeout: 3000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) return resolve("");
        const lines = String(stdout).split("\n").filter(Boolean);
        resolve(lines.slice(0, 30).join("\n") + (lines.length > 30 ? `\n… ${lines.length - 30} more` : ""));
      });
    });

  /** What the harness knows that the sidekick cannot see: the main agent's reads and the working tree. */
  const harnessContext = async (cwd: string, files: string[] = []): Promise<string | undefined> => {
    if (!config.delegation.briefContext) return undefined;
    const parts: string[] = [];
    const reads = recentReads.filter((r) => !files.some((f) => r.startsWith(f)));
    if (reads.length) parts.push(`Files the main agent has already read:\n${reads.map((r) => `- ${r}`).join("\n")}`);
    const status = await gitStatus(cwd);
    if (status) parts.push(`git status:\n${status}`);
    return parts.length ? parts.join("\n\n") : undefined;
  };

  /**
   * Keep the main agent's active tools in line with fusion's state: the
   * sidekick tools while enabled, and (strict mode) no execution tools.
   */
  const setSidekickToolActive = (active: boolean): void => {
    let next = pi.getActiveTools();
    const ours = [toolName, waitToolName];
    if (active) {
      for (const name of ours) if (!next.includes(name)) next = [...next, name];
    } else {
      next = next.filter((name) => !ours.includes(name));
    }
    const strict = active && config.delegation.mode === "strict";
    if (strict) {
      const removing = next.filter((name) => EXECUTION_TOOLS.includes(name));
      strictRemoved = [...new Set([...strictRemoved, ...removing])];
      next = next.filter((name) => !EXECUTION_TOOLS.includes(name));
    } else if (strictRemoved.length) {
      for (const name of strictRemoved) if (!next.includes(name)) next = [...next, name];
      strictRemoved = [];
    }
    const current = pi.getActiveTools();
    if (next.length !== current.length || next.some((name, i) => name !== current[i])) pi.setActiveTools(next);
  };

  /** Deliver a finished background delegation into the main conversation. */
  const deliverBackground = (task: BackgroundTask): void => {
    const outcome = task.outcome;
    if (!outcome) return;
    if (outcome.isError) policy.failedDelegations += 1;
    else policy.failedDelegations = 0;
    // Already handed to the main agent through sidekick_wait: don't deliver it twice.
    if (task.collected) {
      refreshUi();
      return;
    }
    const header = outcome.isError
      ? `[fusion] Background delegation ${task.id} FAILED: ${outcome.errorMessage ?? "unknown error"} (${outcome.meta})`
      : `[fusion] Background delegation ${task.id} finished (${outcome.meta}). Task: ${task.task}`;
    try {
      pi.sendMessage(
        {
          customType: "fusion-result",
          content: outcome.isError ? header : `${header}\n\n${outcome.text}`,
          display: true,
          details: { id: task.id, task: task.task, meta: outcome.meta, isError: outcome.isError, trace: outcome.trace },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] failed to deliver background result:`, error);
    }
    refreshUi();
  };

  // -- tool ----------------------------------------------------------------

  pi.registerTool({
    name: toolName,
    label: "Sidekick",
    description: [
      `Hand labour to the ${TOOL_MARKER} — a persistent, cheaper agent with its own tools and cached context.`,
      "Use it for running tests, builds, linters and installs; recon across many files; reproducing bugs;",
      "mechanical or multi-file edits from an exact brief; and condensing verbose output.",
      "It cannot see this conversation, so the brief must stand alone.",
      "Set background: true to keep working while it runs; the result is delivered to you when done.",
    ].join(" "),
    promptSnippet: "Delegate labour (tests, builds, recon, mechanical edits) to the cheaper Fusion sidekick agent",
    promptGuidelines: [
      `Use ${toolName} by default for labour — tests/builds/linters, multi-file recon, mechanical edits, verbose output — and keep the plan, ambiguity and final review for yourself.`,
      `Every ${toolName} brief must be self-contained: exact paths, exact acceptance criteria, and the exact output you want back.`,
      `Use background: true for slow work and continue with something else; call ${toolName}_wait before you report completion.`,
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The subtask, written as a standalone brief with exact paths and acceptance criteria.",
      }),
      context: Type.Optional(
        Type.String({ description: "Extra context the sidekick needs but cannot discover itself." }),
      ),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files the sidekick should focus on." })),
      expect: Type.Optional(
        StringEnum(["summary", "diff", "evidence", "raw"] as const, {
          description: "Shape of the answer you want back. Default: summary.",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "Run in the background and keep working; the result is delivered when it finishes." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const activeEngine = engine;
      if (!activeEngine) {
        throw new Error("Fusion is not active in this session.");
      }
      activeEngine.setContext(ctx);
      policy.directStreak = 0;
      const input = {
        task: params.task,
        context: params.context,
        files: params.files,
        expect: params.expect,
        harnessContext: await harnessContext(ctx.cwd, params.files),
      };

      if (params.background) {
        const task = activeEngine.startBackground(input, deliverBackground);
        refreshUi(ctx);
        const queued = activeEngine.pendingTasks().length - 1;
        return {
          content: [
            {
              type: "text",
              text:
                `Started background delegation ${task.id}${queued > 0 ? ` (queued behind ${queued})` : ""}. ` +
                "Continue with other work; its result will be delivered to you when it finishes. " +
                `Do not repeat this task. Call ${waitToolName} if you need the result before continuing.`,
            },
          ],
          details: { background: true, id: task.id, meta: "background" },
        };
      }

      let lastActivityCount = 0;
      const progress = setInterval(() => {
        if (activeEngine.activity.length === lastActivityCount) return;
        lastActivityCount = activeEngine.activity.length;
        onUpdate?.({
          content: [{ type: "text", text: activeEngine.activity.slice(-3).join("\n") }],
          details: { progress: true },
        });
      }, 400);

      let outcome;
      try {
        outcome = await activeEngine.delegate(input, signal ?? undefined);
      } finally {
        clearInterval(progress);
      }

      const meta = outcome.meta;
      refreshUi(ctx);
      if (outcome.isError) policy.failedDelegations += 1;
      else policy.failedDelegations = 0;

      if (outcome.isError) {
        await activeEngine.maybeEscalate();
        refreshUi(ctx);
        const authProblem = /api key|auth|unauthorized|forbidden|credential/i.test(
          outcome.errorMessage ?? "",
        );
        // The full trace is not attachable to thrown errors, so embed a compact
        // tail and point at /fusion trace for the complete log.
        const tail = outcome.trace
          .filter((step) => step.kind !== "thinking")
          .slice(-6)
          .map((step) =>
            `  ${step.isError ? "✗" : "·"} ${step.title}${step.detail ? ` — ${truncate(step.detail, 80)}` : ""}`,
          )
          .join("\n");
        throw new Error(
          `Sidekick delegation failed: ${outcome.errorMessage ?? "unknown error"}\n${meta}` +
            (tail ? `\nlast steps:\n${tail}` : "") +
            (authProblem ? "\n(hint: the sidekick provider may have no credentials — /fusion models)" : "") +
            `\n(${EXTENSION_TAG} trace shows the full delegation log)`,
        );
      }

      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          model: outcome.model,
          turns: outcome.turns,
          usage: outcome.usage,
          activity: outcome.activity,
          trace: outcome.trace,
          meta,
        },
        usage: outcome.usage,
      };
    },

    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold(`${toolName} `));
      content += theme.fg("muted", truncate(String(args.task ?? ""), 72));
      component.setText(content);
      return component;
    },

    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "… sidekick working"), 0, 0);
      }
      const details = (result.details ?? {}) as { meta?: string; trace?: TraceStep[]; background?: boolean; id?: string };
      if (details.background) return new Text(theme.fg("accent", `⇢ sidekick ${details.id ?? ""} running in the background`), 0, 0);
      const head = theme.fg("success", "✓ sidekick");
      const meta = theme.fg("dim", ` ${details.meta ?? ""}`);
      const preview = truncate(
        (result.content ?? []).map((part: any) => part.text ?? "").join(" "),
        100,
      );
      const lines = [`${head}${meta}`, theme.fg("toolOutput", preview)];
      const trace = details.trace ?? [];
      if (expanded && trace.length > 0) {
        lines.push(theme.fg("dim", "─".repeat(48)));
        lines.push(...renderTraceSteps(trace, theme));
      } else if (trace.length > 0) {
        lines.push(
          theme.fg(
            "dim",
            `${trace.length} trace step${trace.length === 1 ? "" : "s"} · ${keyHint("app.tools.expand", "to expand")}`,
          ),
        );
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: waitToolName,
    label: "Sidekick wait",
    description:
      "Wait for background sidekick delegations to finish and return their results. With no ids, waits for all outstanding ones.",
    promptSnippet: "Wait for background sidekick delegations and collect their results",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "Delegation ids such as D1. Default: all outstanding." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const activeEngine = engine;
      if (!activeEngine) throw new Error("Fusion is not active in this session.");
      activeEngine.setContext(ctx);
      const tasks = await activeEngine.waitFor(params.ids);
      refreshUi(ctx);
      if (tasks.length === 0) return { content: [{ type: "text", text: "No background delegations are outstanding." }], details: undefined };
      const text = tasks
        .map((t) => {
          const o = t.outcome as DelegationOutcome | undefined;
          if (!o) return `${t.id}: no result`;
          return o.isError ? `${t.id} FAILED: ${o.errorMessage} (${o.meta})` : `${t.id} (${o.meta}):\n${o.text}`;
        })
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { ids: tasks.map((t) => t.id) } };
    },
  });

  // -- delegation policy on the main agent's direct tool calls --------------

  const policyActive = (): boolean =>
    Boolean(engine && allowed && config.enabled && engine.resolveSidekickModel());

  pi.on("tool_call", async (event: any) => {
    const activeEngine = engine;
    const name = String(event.toolName ?? "");
    if (!activeEngine || !policyActive() || name === toolName || name === waitToolName) return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    activeEngine.stats.directCalls += 1;
    policy.directStreak += 1;

    // Don't edit a file a background delegation is changing.
    if (name === "edit" || name === "write") {
      const target = String(input.path ?? input.file_path ?? "");
      const holder = target ? activeEngine.leaseHolder(target) : undefined;
      if (holder) {
        activeEngine.stats.directCalls -= 1;
        return {
          block: true,
          reason:
            `Fusion: background delegation ${holder.id} is changing ${target}. Wait for it with ` +
            `${waitToolName}({ ids: ["${holder.id}"] }), or work on other files meanwhile.`,
        };
      }
    }

    const decision = decideDirectCall(config.delegation.mode, name, input, policy, true, config.delegation);
    if (decision.block) {
      activeEngine.stats.redirected += 1;
      activeEngine.stats.directCalls -= 1;
      refreshUi();
      return { block: true, reason: decision.reason };
    }

    if (name === "read") noteRead(input);
    if (name === "bash" || name === "powershell") {
      const command = String(input.command ?? "");
      const kind = classifyCommand(command);
      if (kind === "verify" || kind === "install") {
        commandStarts.set(String(event.toolCallId), { command, at: Date.now() });
        // A default timeout so one hung test or build cannot stall the main agent.
        if (config.delegation.commandTimeoutSec > 0 && input.timeout === undefined) {
          event.input.timeout = config.delegation.commandTimeoutSec;
        }
      }
    }
    return undefined;
  });

  pi.on("tool_result", async (event: any, ctx) => {
    const activeEngine = engine;
    const name = String(event.toolName ?? "");
    if (!activeEngine || !policyActive() || name === toolName || name === waitToolName) return undefined;
    let content = Array.isArray(event.content) ? [...event.content] : [];
    let changed = false;

    // Learn what test/build/install commands cost, for the adaptive redirect.
    const started = commandStarts.get(String(event.toolCallId));
    if (started) {
      commandStarts.delete(String(event.toolCallId));
      const outputChars = content.reduce((sum: number, part: any) => sum + (part?.type === "text" ? String(part.text ?? "").length : 0), 0);
      recordCommand(policy, started.command, Date.now() - started.at, outputChars);
    }

    // Verbose direct shell output: condense it with the sidekick's model.
    const threshold = config.delegation.compressOutputChars;
    if ((name === "bash" || name === "powershell") && threshold > 0 && config.delegation.mode !== "advisory") {
      const text = content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n");
      if (text.length > threshold) {
        const command = String(event.input?.command ?? "");
        const summary = await activeEngine.compressOutput(command, text, ctx.signal);
        if (summary) {
          let logPath: string | undefined = event.details?.fullOutputPath;
          if (!logPath) {
            try {
              const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-"));
              logPath = path.join(dir, "output.log");
              fs.writeFileSync(logPath, text);
            } catch {
              logPath = undefined;
            }
          }
          content = [
            {
              type: "text",
              text:
                `[fusion] ${text.length.toLocaleString()} chars of output condensed by the sidekick model` +
                `${logPath ? ` (full log: ${logPath} — read targeted ranges only if needed)` : ""}:\n\n${summary.text}`,
            },
          ];
          changed = true;
          refreshUi(ctx);
        }
      }
    }

    // Long runs of direct actions: remind the main agent to delegate.
    const every = config.delegation.nudgeAfter;
    if (every > 0 && config.delegation.mode !== "strict" && policy.directStreak >= every && policy.directStreak % every === 0) {
      content = [...content, { type: "text", text: `\n${nudgeText(policy.directStreak)}` }];
      changed = true;
    }
    return changed ? { content } : undefined;
  });

  // Never let a run settle with sidekick work outstanding: wait for it and hand
  // the results to the main agent for one more turn (it owns the final review).
  pi.on("agent_before_settle", async (event: any) => {
    const activeEngine = engine;
    if (!activeEngine || event.outcome !== "completed") return undefined;
    const pending = activeEngine.pendingTasks().filter((t) => !t.collected);
    if (pending.length === 0) return undefined;
    const tasks = await activeEngine.waitFor(pending.map((t) => t.id));
    refreshUi();
    const body = tasks
      .map((t) => {
        const o = t.outcome as DelegationOutcome | undefined;
        if (!o) return `${t.id}: no result`;
        return o.isError ? `${t.id} FAILED: ${o.errorMessage} (${o.meta})` : `${t.id} (${o.meta}) — ${t.task}\n${o.text}`;
      })
      .join("\n\n");
    return {
      entries: [
        {
          type: "custom_message",
          customType: "fusion-result",
          content: `[fusion] Background delegations finished before you wrapped up. Review them and update your answer if needed.\n\n${body}`,
          display: true,
          details: { id: tasks.map((t) => t.id).join(", "), meta: `${tasks.length} background result(s)`, isError: tasks.some((t) => t.outcome?.isError) },
        },
      ],
      continue: true,
    };
  });

  pi.registerEntryRenderer("fusion-tasks", (entry: any, _options: any, theme: any) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.bold("sidekick background delegations"), 0, 0));
    for (const line of (entry.data?.lines ?? []) as string[]) box.addChild(new Text(line, 0, 0));
    return box;
  });

  pi.registerMessageRenderer("fusion-result", (message: any, { expanded }: any, theme: any) => {
    const details = (message.details ?? {}) as { id?: string; meta?: string; isError?: boolean; trace?: TraceStep[]; task?: string };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const flag = details.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    box.addChild(new Text(`${theme.bold(`sidekick ${details.id ?? ""}`)} ${flag} ${theme.fg("dim", details.meta ?? "")}`, 0, 0));
    if (details.task) box.addChild(new Text(theme.fg("muted", truncate(details.task, 160)), 0, 0));
    const body = typeof message.content === "string" ? message.content : "";
    const text = body.split("\n\n").slice(1).join("\n\n");
    if (text) box.addChild(new Text(expanded ? text : truncate(text, 200), 0, 0));
    if (expanded && details.trace?.length) for (const line of renderTraceSteps(details.trace, theme)) box.addChild(new Text(line, 0, 0));
    return box;
  });

  // -- session lifecycle ---------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadFusionConfig();
    if (!allowed) config.enabled = false;
    restoreRoutedSidekick(config, ctx);
    engine = new FusionEngine(pi, ctx.modelRegistry, ctx.cwd, config);
    engine.setContext(ctx);
    userPickedModel = false;

    // Another extension may have claimed the same tool name; surface it rather
    // than silently losing one of the two tools.
    const registered = pi.getAllTools().find((tool) => tool.name === toolName);
    if (registered && !registered.description.includes(TOOL_MARKER) && ctx.hasUI) {
      ctx.ui.notify(
        `fusion: another extension registered a "${toolName}" tool — disable one of them.`,
        "warning",
      );
    }

    setSidekickToolActive(config.enabled);
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    strictRemoved = [];
    engine?.cancel();
    recentReads = [];
    commandStarts.clear();
    engine?.dispose();
    engine = undefined;
  });

  pi.on("model_select", (event) => {
    if (internalModelChange) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
  });

  // -- main-agent guidance -------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    const activeEngine = engine;
    if (!activeEngine) return;
    const options = event.systemPromptOptions;
    if (!options) return;

    const sidekickModel = activeEngine.resolveSidekickModel();
    const shouldEnable = activeEngine.config.enabled && sidekickModel !== undefined;

    setSidekickToolActive(shouldEnable);
    policy.directStreak = 0;
    if (!options.sections) return;
    if (!shouldEnable) {
      // Removing the key makes pi emit a section patch that drops it.
      delete options.sections[EXTENSION_TAG];
      return;
    }
    options.sections[EXTENSION_TAG] = buildMainGuidance(
      toolName,
      sidekickModel,
      activeEngine.config.delegation.mode === "strict"
        ? [...new Set([...activeEngine.config.sidekickTools, "read", "grep", "find", "ls", "bash", "edit", "write"])]
        : activeEngine.config.sidekickTools,
      activeEngine.config.delegation.mode,
    );
  });

  // -- main-model cost accounting -----------------------------------------

  pi.on("turn_end", async (event) => {
    const activeEngine = engine;
    if (!activeEngine) return;
    if (event.message?.role === "assistant") {
      addUsage(activeEngine.stats.mainUsage, event.message.usage);
    }
  });

  // -- dynamic mid-session routing ----------------------------------------

  pi.on("session_compact", async (_event, ctx) => {
    const activeEngine = engine;

    if (!activeEngine || !config.enabled) return;
    if (!config.routing.enabled || !config.routing.onCompact) return;
    // Never fight the user over an explicitly chosen model.
    if (userPickedModel) return;

    try {
      const transcript = buildTranscript(ctx);
      if (!transcript.trim()) return;
      const decision = await activeEngine.classify(ctx, transcript);
      if (!decision || (decision.main === "keep" && decision.sidekick === "keep")) return;

      internalModelChange = true;
      let records: RouteRecord[];
      try {
        records = await activeEngine.applyRouting(decision, "compact");
      } finally {
        internalModelChange = false;
      }

      const applied = records.filter((record) => record.applied);
      if (applied.length > 0 && ctx.hasUI) {
        for (const record of applied) {
          ctx.ui.notify(
            `fusion routed ${record.slot}: ${record.from} → ${record.to} (${record.reason})`,
            "info",
          );
        }
      } else if (records.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `fusion suggests ${records.map((record) => `${record.slot}:${record.to}`).join(", ")} — /fusion route to apply`,
          "info",
        );
      }
      refreshUi(ctx);
    } catch (error) {
      console.error(`[${EXTENSION_TAG}] compaction routing failed:`, error);
    }
  });

  // -- main-slot sync ------------------------------------------------------

  /**
   * Point the session model (the footer's bottom-right display) at fusion's
   * main slot. `/fusion on` and the wizard state toggle call this so the
   * harness is actually live on the main model. Fusion-driven switches don't
   * count as user picks, so dynamic routing keeps ownership of the main slot.
   */
  const applyFusionMainSlot = async (ctx: ExtensionContext): Promise<void> => {
    const target = engine?.resolveMainModel();
    if (!target) {
      const wanted = config.main ? `${config.main.provider}/${config.main.modelId}` : "(unset)";
      ctx.ui.notify(`fusion: main model ${wanted} is unavailable (no auth?) — session model unchanged.`, "error");
      return;
    }
    const current = ctx.model;
    if (current && modelsAreEqual(target, current)) return;

    const effort = clampEffort(target, config.main?.effort);
    const ok = await internalSetModel(target);
    if (!ok) {
      ctx.ui.notify(`fusion: no auth for main ${modelKey(target)} — session model unchanged.`, "error");
      return;
    }
    if (effort) pi.setThinkingLevel(effort);
    // Keep the first pre-fusion model across repeated syncs.
    if (!preFusionModel) preFusionModel = current;
    ctx.ui.notify(
      `fusion main: ${current ? `${modelKey(current)} → ` : ""}${modelKey(target)}` +
        `${effort ? ` (effort: ${effort})` : ""}`,
      "info",
    );
  };

  /**
   * On /fusion off, hand the main slot back to whatever was active before
   * fusion enabled — unless the user explicitly picked a model since, in which
   * case their pick wins and stays.
   */
  const restorePreFusionModel = async (ctx: ExtensionContext): Promise<void> => {
    const target = preFusionModel;
    preFusionModel = undefined;
    if (!target || userPickedModel) return;
    const current = ctx.model;
    if (current && modelsAreEqual(target, current)) return;
    const ok = await internalSetModel(target);
    if (ok) ctx.ui.notify(`fusion off — main restored to ${modelKey(target)}.`, "info");
  };

  /**
   * Assign the main slot. The choice is persisted; the session model follows
   * only while fusion is on (otherwise the slot is just remembered).
   */
  const assignMain = async (ctx: ExtensionContext, model: Model<any>, effort: EffortLevel | undefined): Promise<void> => {
    config.main = { provider: model.provider, modelId: model.id, effort };
    if (engine) engine.config = config;
    persistConfig();
    if (!isActive()) {
      ctx.ui.notify(`Fusion main set to ${modelKey(model)}${effort ? ` (effort: ${effort})` : ""} — applies on /fusion on.`, "info");
      refreshUi(ctx);
      return;
    }
    await applyFusionMainSlot(ctx);
    refreshUi(ctx);
  };

  /** Assign the sidekick slot (a deliberate choice: persisted, not a routing record). */
  const assignSidekick = (ctx: ExtensionContext, model: Model<any>, effort: EffortLevel | undefined): void => {
    engine?.setSidekickModel(model, effort);
    config.sidekick = { provider: model.provider, modelId: model.id, effort };
    persistConfig();
    ctx.ui.notify(`Sidekick switched to ${modelKey(model)}${effort ? ` (effort: ${effort})` : ""}.`, "info");
    refreshUi(ctx);
  };

  const wizardHooks = (): WizardHooks => ({
    persist: persistConfig,
    assignMain,
    assignSidekick,
    appendStats: (activeEngine) => pi.appendEntry("fusion-stats", activeEngine.snapshot()),
    refreshUi,
    setEnableState: async (wizardCtx, enabled) => {
      if (enabled) await applyFusionMainSlot(wizardCtx);
      else await restorePreFusionModel(wizardCtx);
    },
  });

  // -- commands ------------------------------------------------------------

  pi.registerCommand("fusion", {
    description: "Fusion hybrid harness: status, model configuration, routing and stats",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.startsWith("mode ")) {
        const rest = prefix.slice(5);
        const modes = ["strict", "balanced", "advisory"].filter((m) => m.startsWith(rest)).map((m) => ({ value: `mode ${m}`, label: m }));
        return modes.length ? modes : null;
      }
      const items = ["on", "off", "main", "sidekick", "mode", "tasks", "cancel", "status", "stats", "models", "route", "trace", "reset", "help"].map((value) => ({
        value,
        label: value,
      }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const activeEngine = engine;
      if (!activeEngine) {
        ctx.ui.notify("Fusion is not active in this session.", "error");
        return;
      }

      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      switch (sub) {
        case "main":
        case "sidekick": {
          const slot = sub as "main" | "sidekick";
          const current = slot === "main" ? activeEngine.resolveMainModel() : activeEngine.resolveSidekickModel();
          const modelArg = args.trim().replace(/^(main|sidekick)\s*/i, "").trim();
          if (modelArg) {
            const target = findModelByRef(ctx.modelRegistry.getAll() || [], modelArg);
            if (!target) {
              ctx.ui.notify(`No model matches "${modelArg}".`, "error");
              return;
            }
            const fallback: EffortLevel = slot === "main" ? "high" : "low";
            const effort = clampThinkingLevel(target, config[slot]?.effort || fallback) as EffortLevel;
            if (slot === "main") await assignMain(ctx, target, effort);
            else assignSidekick(ctx, target, effort);
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify(`${slot}=${modelKey(current)}`, "info");
            return;
          }
          const result = await showModelPicker(ctx, pi, {
            target: slot === "main" ? "fusion-main" : "fusion-sidekick",
            title: slot === "main" ? "Pick the main (frontier) agent model" : "Pick the sidekick (cheap) agent model",
            initialModel: current ?? config[slot],
            initialEffort: config[slot]?.effort as any,
          });
          if (!result) return;
          if (slot === "main") await assignMain(ctx, result.model, result.effort as EffortLevel);
          else assignSidekick(ctx, result.model, result.effort as EffortLevel);
          return;
        }
        case "on":
        case "off": {
          if (!allowed) {
            ctx.ui.notify("Fusion is disabled inside factory worker processes.", "info");
            return;
          }
          config.enabled = sub === "on";
          persistConfig();
          activeEngine.config = config;
          setSidekickToolActive(config.enabled);
          // Sync the session model (footer bottom-right) with the fusion main
          // slot on enable; hand it back on disable.
          if (config.enabled) {
            await applyFusionMainSlot(ctx);
          } else {
            await restorePreFusionModel(ctx);
          }
          refreshUi(ctx);
          ctx.ui.notify(`Fusion ${config.enabled ? "enabled" : "disabled"}.`, "info");
          return;
        }

        case "tasks": {
          const tasks = [...activeEngine.tasks.values()];
          if (tasks.length === 0) {
            ctx.ui.notify("No background delegations in this session.", "info");
            return;
          }
          pi.appendEntry("fusion-tasks", {
            lines: tasks.map((t) => {
              const secs = Math.round((Date.now() - t.startedAt) / 1000);
              const leases = t.leases.size ? ` · editing ${[...t.leases].map((l) => l.replace(`${ctx.cwd}/`, "")).join(", ")}` : "";
              return `${t.id} ${t.status}${t.status === "queued" || t.status === "running" ? ` (${secs}s)` : ""} · ${t.task}${leases}`;
            }),
          });
          return;
        }

        case "cancel": {
          const ids = args.trim().split(/\s+/).slice(1).filter((id) => id && id !== "all");
          const cancelled = activeEngine.cancel(ids);
          refreshUi(ctx);
          ctx.ui.notify(cancelled.length ? `Cancelled ${cancelled.join(", ")}.` : "No matching background delegation is running.", "info");
          return;
        }

        case "mode": {
          const value = args.trim().split(/\s+/)[1]?.toLowerCase() as DelegationMode | undefined;
          if (!value || !["strict", "balanced", "advisory"].includes(value)) {
            ctx.ui.notify(
              `Delegation mode: ${config.delegation.mode}. Usage: /fusion mode strict|balanced|advisory\n` +
                "strict = main agent read-only, sidekick does all execution; balanced = tests/builds/installs and verbose output go to the sidekick; advisory = prompt only.",
              "info",
            );
            return;
          }
          config.delegation = { ...config.delegation, mode: value };
          activeEngine.config = config;
          persistConfig();
          setSidekickToolActive(config.enabled);
          refreshUi(ctx);
          ctx.ui.notify(`Fusion delegation mode: ${value}.`, "info");
          return;
        }

        case "stats":
        case "status": {
          pi.appendEntry("fusion-stats", activeEngine.snapshot());
          return;
        }

        case "trace": {
          const trace = activeEngine.lastTrace;
          if (!trace || trace.steps.length === 0) {
            ctx.ui.notify("No sidekick delegation has run yet in this session.", "info");
            return;
          }
          pi.appendEntry("fusion-trace", trace);
          return;
        }

        case "reset": {
          activeEngine.resetSidekick();
          activeEngine.resetSessionStats();
          refreshUi(ctx);
          ctx.ui.notify("Fusion sidekick context and session stats reset.", "info");
          return;
        }

        case "route": {
          const decision = await activeEngine.classify(ctx, buildTranscript(ctx));
          if (!decision) {
            ctx.ui.notify("Routing classifier is off — enable it in /fusion models.", "info");
            return;
          }
          const records = await activeEngine.applyRouting(decision, "manual");
          if (records.length === 0) {
            ctx.ui.notify(
              `No routing change suggested (difficulty ${decision.difficulty}/5: ${decision.reason}).`,
              "info",
            );
            return;
          }
          for (const record of records) {
            ctx.ui.notify(
              record.applied
                ? `fusion routed ${record.slot}: ${record.from} → ${record.to}`
                : `fusion suggests ${record.slot}: ${record.to} (auto-apply is off)`,
              "info",
            );
          }
          refreshUi(ctx);
          return;
        }

        case "models":
        case "": {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              `main=${modelKey(activeEngine.resolveMainModel())} ` +
                `sidekick=${modelKey(activeEngine.resolveSidekickModel())}`,
              "info",
            );
            return;
          }
          await openConfigWizard(ctx, activeEngine, wizardHooks(), pi);
          return;
        }

        default: {
          ctx.ui.notify("Usage: /fusion [on|off|main|sidekick|mode|tasks|cancel|status|stats|models|route|trace|reset]", "info");
        }
      }
    },
  });

  pi.registerShortcut(resolveFusionShortcut(config) as KeyId, {
    description: "Open the Fusion menu",
    handler: async (ctx) => {
      const activeEngine = engine;
      if (!activeEngine || !ctx.hasUI) return;
      await openConfigWizard(ctx, activeEngine, wizardHooks(), pi);
    },
  });

  // -- transcript rendering ------------------------------------------------

  pi.registerEntryRenderer("fusion-trace", (entry, { expanded }, theme) => {
    const trace = (entry.data ?? {}) as DelegationTrace;
    const steps = trace.steps ?? [];
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const flag = trace.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    box.addChild(
      new Text(`${theme.bold("sidekick trace")} ${flag} ${theme.fg("dim", trace.meta ?? "")}`, 0, 0),
    );
    if (trace.task) box.addChild(new Text(theme.fg("muted", truncate(trace.task, 200)), 0, 0));
    if (!expanded) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `${steps.length} step${steps.length === 1 ? "" : "s"} · ${keyHint("app.tools.expand", "to expand")}`,
          ),
          0,
          0,
        ),
      );
      return box;
    }
    const lines = renderTraceSteps(steps, theme);
    if (lines.length === 0) box.addChild(new Text(theme.fg("dim", "(no steps recorded)"), 0, 0));
    for (const line of lines) box.addChild(new Text(line, 0, 0));
    return box;
  });

  pi.registerEntryRenderer("fusion-route", (entry, { expanded }, theme) => {
    const record = (entry.data ?? {}) as RouteRecord;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const arrow = record.applied ? theme.fg("success", "→") : theme.fg("warning", "⇢");
    const slot = theme.fg("accent", record.slot ?? "?");
    box.addChild(
      new Text(
        `${theme.bold("fusion route")} ${arrow} ${slot}: ` +
          `${theme.fg("dim", record.from ?? "?")} → ${theme.fg("toolOutput", record.to ?? "?")}`,
        0,
        0,
      ),
    );
    box.addChild(
      new Text(
        theme.fg(
          "dim",
          `${record.trigger}${record.difficulty ? ` · difficulty ${record.difficulty}/5` : ""} · ${record.reason ?? ""}`,
        ),
        0,
        0,
      ),
    );
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", JSON.stringify(record, null, 2)), 0, 0));
    }
    return box;
  });

  pi.registerEntryRenderer("fusion-stats", (entry, { expanded }, theme) => {
    const stats = (entry.data ?? {}) as FusionStats & { lifetime?: LifetimeStats };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const ratio =
      stats.estimatedMainCost > 0
        ? Math.max(
            0,
            (stats.estimatedMainCost - (stats.sidekickUsage?.cost?.total ?? 0)) / stats.estimatedMainCost,
          )
        : 0;
    box.addChild(new Text(theme.bold("fusion session"), 0, 0));
    box.addChild(
      new Text(
        `delegations ${stats.delegations ?? 0} (${stats.failures ?? 0} failed) · ` +
          `sidekick turns ${stats.sidekickTurns ?? 0}`,
        0,
        0,
      ),
    );
    box.addChild(
      new Text(
        `sidekick ${formatCost(stats.sidekickUsage?.cost?.total ?? 0)} · ` +
          `main ${formatCost(stats.mainUsage?.cost?.total ?? 0)} · ` +
          `est. main-only ${formatCost(stats.estimatedMainCost ?? 0)} · ` +
          theme.fg("success", `saved ${(ratio * 100).toFixed(0)}%`),
        0,
        0,
      ),
    );
    box.addChild(
      new Text(
        `direct calls ${stats.directCalls ?? 0} · redirected to sidekick ${stats.redirected ?? 0} · ` +
          `background ${stats.background ?? 0} · outputs condensed ${stats.compressed ?? 0}` +
          `${stats.charsKeptOut ? ` (${Math.round(stats.charsKeptOut / 1000)}k chars kept out of the main context)` : ""}`,
        0,
        0,
      ),
    );
    if (stats.lifetime) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `lifetime: ${stats.lifetime.delegations} delegations · ` +
              `sidekick ${formatCost(stats.lifetime.sidekickCost)} · ` +
              `est. main-only ${formatCost(stats.lifetime.estimatedMainCost)} · ` +
              `saved ${formatCost(Math.max(0, stats.lifetime.estimatedMainCost - stats.lifetime.sidekickCost))}`,
          ),
          0,
          0,
        ),
      );
    }
    if (expanded && stats.routes?.length) {
      box.addChild(new Text(theme.bold("routing decisions"), 0, 0));
      for (const route of stats.routes.slice(-10)) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `${new Date(route.at).toLocaleTimeString()} ${route.trigger} ${route.slot}: ` +
                `${route.from} → ${route.to}${route.applied ? "" : " (not applied)"}`,
            ),
            0,
            0,
          ),
        );
      }
    }
    return box;
  });
}

// ---------------------------------------------------------------------------
// Interactive configuration wizard
// ---------------------------------------------------------------------------

interface WizardHooks {
  persist: () => void;
  assignMain: (ctx: ExtensionContext, model: Model<any>, effort: EffortLevel | undefined) => Promise<void>;
  assignSidekick: (ctx: ExtensionContext, model: Model<any>, effort: EffortLevel | undefined) => void;
  appendStats: (engine: FusionEngine) => void;
  refreshUi: (ctx?: ExtensionContext) => void;
  /** Sync the session model with the main slot when fusion is toggled. */
  setEnableState: (ctx: ExtensionContext, enabled: boolean) => Promise<void>;
}

async function openConfigWizard(
  ctx: ExtensionContext,
  engine: FusionEngine,
  hooks: WizardHooks,
  pi: ExtensionAPI,
): Promise<void> {
  while (true) {
    const routing = engine.config.routing;
    const choice = await ctx.ui.select("Fusion", [
      `main agent: ${modelKey(engine.resolveMainModel())}` +
        `${engine.config.main?.effort ? ` (${engine.config.main.effort})` : ""}`,
      `sidekick: ${modelKey(engine.resolveSidekickModel())}` +
        `${engine.config.sidekick?.effort ? ` (${engine.config.sidekick.effort})` : ""}`,
      `sidekick tools: ${engine.config.sidekickTools.join(", ") || "(none)"}`,
      `delegation: ${engine.config.delegation.mode}`,
      `routing: ${routing.enabled ? (routing.autoApply ? "auto" : "suggest-only") : "off"} · ${routing.mode}`,
      `menu shortcut: ${resolveFusionShortcut(engine.config)}`,
      `state: ${engine.config.enabled ? "enabled" : "disabled"}`,
      "session stats",
      "last delegation trace",
      "route now",
      "reset sidekick context",
      "done",
    ]);
    if (!choice || choice === "done") return;

    if (choice.startsWith("main agent:") || choice.startsWith("sidekick:")) {
      const slot = choice.startsWith("main agent:") ? "main" : "sidekick";
      const result = await showModelPicker(ctx, pi, {
        target: slot === "main" ? "fusion-main" : "fusion-sidekick",
        title: slot === "main" ? "Pick the main (frontier) agent model" : "Pick the sidekick (cheap) agent model",
        initialModel: (slot === "main" ? engine.resolveMainModel() : engine.resolveSidekickModel()) ?? engine.config[slot],
        initialEffort: engine.config[slot]?.effort as any,
      });
      if (!result) continue;
      if (slot === "main") await hooks.assignMain(ctx, result.model, result.effort as EffortLevel);
      else hooks.assignSidekick(ctx, result.model, result.effort as EffortLevel);
      continue;
    }

    if (choice.startsWith("sidekick tools:")) {
      const all = ["read", "grep", "find", "ls", "bash", "edit", "write"];
      const selected = new Set(engine.config.sidekickTools);
      while (true) {
        const toolChoice = await ctx.ui.select(
          "Sidekick tools",
          [...all.map((name) => `${selected.has(name) ? "[x]" : "[ ]"} ${name}`), "done"],
        );
        if (!toolChoice || toolChoice === "done") break;
        const name = toolChoice.replace(/^\[[ x]\] /, "");
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
      }
      engine.config.sidekickTools = all.filter((name) => selected.has(name));
      engine.resetSidekick();
      hooks.persist();
      ctx.ui.notify(`Sidekick tools: ${engine.config.sidekickTools.join(", ") || "(none)"}`, "info");
      continue;
    }

    if (choice.startsWith("delegation:")) {
      const modeChoice = await ctx.ui.select("Delegation mode", [
        "balanced — tests/builds/installs and verbose output go to the sidekick",
        "strict — main agent is read-only; the sidekick does all execution and edits",
        "advisory — prompt guidance only",
      ]);
      if (modeChoice) {
        engine.config.delegation = { ...engine.config.delegation, mode: modeChoice.split(" ")[0] as DelegationMode };
        hooks.persist();
        hooks.refreshUi(ctx);
        ctx.ui.notify(`Delegation mode: ${engine.config.delegation.mode} (applies from your next message).`, "info");
      }
      continue;
    }

    if (choice.startsWith("routing:")) {
      const modeChoice = await ctx.ui.select("Routing classifier", ["llm", "heuristic", "off"]);
      if (modeChoice) engine.config.routing.mode = modeChoice as FusionRoutingConfig["mode"];
      const applyChoice = await ctx.ui.select("Apply routing changes", ["automatically", "suggest only"]);
      engine.config.routing.autoApply = applyChoice !== "suggest only";
      const enabledChoice = await ctx.ui.select("Dynamic routing", ["enabled", "disabled"]);
      engine.config.routing.enabled = enabledChoice !== "disabled";
      hooks.persist();
      continue;
    }

    if (choice.startsWith("menu shortcut:")) {
      ctx.ui.notify(
        `Fusion menu shortcut: ${resolveFusionShortcut(engine.config)}. ` +
          `Change it with "shortcut" in ${CONFIG_PATH_HINT()}, then run /reload.`,
        "info",
      );
      continue;
    }

    if (choice.startsWith("state:")) {
      engine.config.enabled = !engine.config.enabled;
      hooks.persist();
      await hooks.setEnableState(ctx, engine.config.enabled);
      ctx.ui.notify(`Fusion ${engine.config.enabled ? "enabled" : "disabled"}.`, "info");
      continue;
    }

    if (choice === "session stats") {
      hooks.appendStats(engine);
      continue;
    }

    if (choice === "last delegation trace") {
      if (!engine.lastTrace || engine.lastTrace.steps.length === 0) {
        ctx.ui.notify("No sidekick delegation has run yet.", "info");
      } else {
        pi.appendEntry("fusion-trace", engine.lastTrace);
      }
      continue;
    }

    if (choice === "route now") {
      const decision = await engine.classify(ctx, buildTranscript(ctx));
      if (!decision) {
        ctx.ui.notify("Routing classifier is off.", "info");
        continue;
      }
      const records = await engine.applyRouting(decision, "manual");
      ctx.ui.notify(
        records.length > 0
          ? records
              .map((record) =>
                `${record.slot}: ${record.from} → ${record.to}${record.applied ? "" : " (not applied)"}`,
              )
              .join("\n")
          : `No change suggested (difficulty ${decision.difficulty}/5: ${decision.reason})`,
        "info",
      );
      continue;
    }

    if (choice === "reset sidekick context") {
      engine.resetSidekick();
      ctx.ui.notify("Sidekick context reset.", "info");
      continue;
    }
  }
}

