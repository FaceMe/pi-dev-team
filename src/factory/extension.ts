/**
 * pi software factory — the `/factory` command.
 *
 *   /factory new [idea]      quick setup (prefilled; Enter accepts) → interview → spec → … → release
 *   /factory resume|pause    continue / pause the run in this folder
 *   /factory status|cost     where the run is and what it has spent
 *   /factory board           the run at a glance: phase, tickets, spend
 *   /factory trace [id]      the last worker trace for a ticket id or role
 *   /factory history [id]    a ticket's history (QA, attempts, gates, review, merges), or all tickets
 *   /factory doctor [probe]  check the machine and the team, with fixes
 *   /factory team [preset]   show the team, or switch preset (balanced|cheap|best|refresh)
 *   /factory roles           assign models to roles with the picker
 *   /factory autonomy <p>    auto | balanced | careful
 *   /factory settings        change the quick-setup answers for this folder
 *   /factory run <role> <brief>   run one role once (read-only), e.g. to try a model
 *   /factory demo            build a tiny sample project in a temp folder
 *
 * Inside a worker process (PI_FACTORY_WORKER=1) this extension only installs
 * the write-scope / destructive-command guard.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { pricePerToken } from "../shared/models.js";
import { truncate } from "../shared/text.js";
import { renderTraceSteps } from "../shared/trace.js";
import { formatCost, formatTokens } from "../shared/usage.js";
import { showModelPicker } from "../picker/model-picker.js";
import { agentLines, boardLines, taskLines } from "./board.js";
import { buildCostReport, renderCostReport } from "./cost.js";
import { formatDoctor, probeModels, runDoctor } from "./doctor.js";
import { blockedCommand, inWriteScope } from "./guard.js";
import { historyOverview, ticketHistory } from "./history.js";
import { FactoryRun, makeRunId, newState } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import { loadRoles } from "./roles.js";
import { PiSubprocessRunner, piInvocation, WORKER_ENV } from "./runner.js";
import {
  defaultAnswers,
  detectDeployTargets,
  detectStack,
  detectWebAccess,
  estimateBudget,
  loadUserDefaults,
  saveUserDefaults,
} from "./settings.js";
import { AUTONOMY_TEXT, runQuickSetup, runRoleSetup } from "./setup.js";
import { selectFactoryMenu } from "./menu.js";
import { showSpecViewer } from "./spec-view.js";
import { integrationSettings, integrationDiagnostics } from "./integrations.js";
import { runIntegrationSetup } from "./integration-setup.js";
import { Mutex } from "./mutex.js";
import { FactoryStore } from "./store.js";
import { buildTeam, describeTeam } from "./team.js";
import type { Team } from "./team.js";
import type { Autonomy, FactoryState, FactoryUI, SetupAnswers, TeamPreset, WorkerRunner } from "./types.js";
import { runSettings } from "./types.js";

const TAG = "factory";
const DEMO_IDEA =
  "A small command-line to-do list: add, list, complete and delete tasks, stored in a local JSON file, with a --help screen.";

// ---------------------------------------------------------------------------
// Worker mode: guard every tool call against the ticket's write scope
// ---------------------------------------------------------------------------

export function registerWorkerGuard(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  let scope: string[] = [];
  try {
    const parsed = JSON.parse(env[WORKER_ENV.writeScope] ?? "[]");
    if (Array.isArray(parsed)) scope = parsed.filter((g) => typeof g === "string");
  } catch {
    scope = [];
  }
  const allowDeploy = env[WORKER_ENV.allowDeploy] === "1";

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    const name = String(event.toolName ?? "");
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (name === "edit" || name === "write") {
      const target = String(input.path ?? input.file_path ?? "");
      if (!inWriteScope(ctx.cwd, target, scope)) {
        return {
          block: true,
          reason: scope.length
            ? `The factory only allows this worker to change: ${scope.join(", ")}. "${target}" is outside that scope.`
            : "This worker is read-only in the factory.",
        };
      }
    }
    if (name === "bash" || name === "powershell") {
      const reason = blockedCommand(String(input.command ?? ""), { allowDeploy, cwd: ctx.cwd });
      if (reason) return { block: true, reason: `Blocked by the factory: ${reason}.` };
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUi(pi: ExtensionAPI, ctx: ExtensionContext, dialogLock?: Mutex, signal?: AbortSignal): FactoryUI {
  const hasUI = ctx.hasUI;
  const dialog = <T>(action: () => Promise<T>): Promise<T> => dialogLock ? dialogLock.run(action) : action();
  return {
    notify: (message, level = "info") => ctx.ui.notify(message, level),
    select: async (title, options, settings) => dialog(async () => hasUI ? selectFactoryMenu(ctx, title, options, settings?.initialIndex, signal) : undefined),
    input: async (title, placeholder) => dialog(async () => hasUI && !signal?.aborted ? ctx.ui.input(title, placeholder, { signal }) : undefined),
    confirm: async (title, message) => dialog(async () => hasUI && !signal?.aborted ? ctx.ui.confirm(title, message, { signal }) : false),
    viewSpec: async markdown => dialog(async () => {
      pi.appendEntry(TAG, { kind: "report", text: markdown });
      if (hasUI) await showSpecViewer(ctx, "Factory specification", markdown, signal);
    }),
    editSpec: async markdown => dialog(async () => hasUI && !signal?.aborted ? ctx.ui.editor("Edit specification draft", markdown) : undefined),
    status: (text) => {
      try {
        ctx.ui.setStatus(TAG, text);
      } catch {
        /* UI gone */
      }
    },
    widget: (lines) => {
      try {
        ctx.ui.setWidget(TAG, lines);
      } catch {
        /* UI gone */
      }
    },
    log: (kind, data) => pi.appendEntry(TAG, { kind, ...data }),
  };
}

function toolNames(pi: ExtensionAPI): string[] {
  try {
    return pi.getAllTools().map((tool) => tool.name);
  } catch {
    return [];
  }
}

/** `pi install npm:pi-web-access` using the same pi the workers use. */
export function installWebAccess(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const inv = piInvocation(["install", "npm:pi-web-access"]);
    let output = "";
    const child = spawn(inv.command, inv.args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

function stateSummary(state: FactoryState): string[] {
  const done = state.tickets.filter((t) => t.status === "done").length;
  const lines = [
    `run ${state.runId} · ${state.phase} · ${state.status}`,
    `idea: ${truncate(state.idea, 120)}`,
    `spent: ${formatCost(state.spentUsd)}${state.budgetUsd ? ` of $${state.budgetUsd}` : ""} · ${formatTokens(state.spentTokens)} tokens`,
  ];
  if (state.tickets.length) {
    lines.push(`tickets: ${done}/${state.tickets.length} done`);
    for (const t of state.tickets) lines.push(`  ${t.status === "done" ? "✓" : t.status === "in_progress" ? "…" : t.status === "skipped" ? "–" : t.status === "blocked" ? "✗" : "·"} ${t.id} ${t.title}`);
  }
  if (state.branch) lines.push(`branch: ${state.branch}`);
  if (state.lastError && state.status !== "done") lines.push(`last stop: ${state.lastError}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export interface FactoryExtensionOptions {
  /** Test hook: replace the subprocess runner. */
  runner?: WorkerRunner;
}

export function createFactoryExtension(options: FactoryExtensionOptions = {}) {
  return function factoryExtension(pi: ExtensionAPI): void {
    if (process.env[WORKER_ENV.worker] === "1") {
      registerWorkerGuard(pi);
      return;
    }

    const runner = options.runner ?? new PiSubprocessRunner();
    // Commands and background approval dialogs share one terminal surface.
    const dialogLock = new Mutex();
    let active: { run: FactoryRun; controller: AbortController; promise: Promise<FactoryState>; cwd: string } | undefined;

    const rolesFor = (cwd: string) => loadRoles({ projectDir: cwd, trustProject: false });

    const teamFor = (ctx: ExtensionContext, answers: Pick<SetupAnswers, "teamPreset" | "pins">): Team =>
      buildTeam(ctx.modelRegistry, rolesFor(ctx.cwd), answers);

    const startRun = (ctx: ExtensionContext, cwd: string, answers: SetupAnswers, state: FactoryState, webAccess: boolean): Promise<FactoryState> => {
      const store = new FactoryStore(cwd);
      const controller = new AbortController();
      const ui = makeUi(pi, ctx, dialogLock, controller.signal);
      const deps: PipelineDeps = {
        cwd,
        ui,
        runner,
        roles: rolesFor(cwd),
        team: teamFor(ctx, answers),
        answers,
        store,
        webAccess,
        signal: controller.signal,
      };
      const run = new FactoryRun(deps, state);
      const promise = run.run().finally(() => {
        if (active?.run === run) active = undefined;
      });
      active = { run, controller, promise, cwd };
      return promise;
    };

    /** Interactive sessions keep working while the factory runs; headless ones (print/JSON/RPC without UI) wait. */
    const follow = async (ctx: ExtensionContext, promise: Promise<FactoryState>): Promise<void> => {
      if (ctx.hasUI) return;
      const final = await promise;
      pi.appendEntry(TAG, { kind: "status", lines: stateSummary(final) });
    };

    /** Quick setup with prefilled answers. Returns undefined when cancelled. */
    const quickSetup = async (ctx: ExtensionContext, cwd: string, idea: string, forceDefaults = false, mode: "start" | "settings" | "roles" = "start"): Promise<{ answers: SetupAnswers; webAccess: boolean } | undefined> => {
      const store = new FactoryStore(cwd);
      const user = loadUserDefaults();
      const names = toolNames(pi);
      const webAccessInstalled = detectWebAccess(names);
      const roles = rolesFor(cwd);
      const deployTargets = detectDeployTargets();
      const baseTeam = buildTeam(ctx.modelRegistry, roles, { teamPreset: user.teamPreset ?? "balanced", pins: user.pins ?? {} });
      const budget = estimateBudget(baseTeam, idea, (p, id) => ctx.modelRegistry.find(p, id));
      const initial = defaultAnswers({ cwd, toolNames: names, budget, deployTargets }, user, store.loadProject());

      let answers: SetupAnswers | undefined = initial;
      if (ctx.hasUI && !forceDefaults) {
        answers = await (mode === "roles" ? runRoleSetup : runQuickSetup)(initial, {
          ui: makeUi(pi, ctx),
          mode: mode === "start" ? "start" : "settings",
          roles: [...roles.keys()],
          roleGroups: [
            { label: "planning and review roles", roles: ["analyst", "researcher", "architect", "planner", "reviewer"] },
            { label: "build roles", roles: ["backend", "frontend", "devops"] },
            { label: "design and frontend roles", roles: ["designer", "frontend"] },
            { label: "test and documentation roles", roles: ["qa", "contributor", "docs"] },
          ],
          deployTargets,
          webAccessInstalled,
          detectedStack: detectStack(cwd),
          budgetEstimate: budget,
          previewTeam: (a) => buildTeam(ctx.modelRegistry, roles, a),
          configureIntegrations: current => runIntegrationSetup(current, makeUi(pi, ctx), names),
          pickModel: async (role, current) => {
            const result = await showModelPicker(ctx, pi, { target: "select", title: `Model for ${role}`, initialModel: current, initialEffort: current?.effort });
            return result ? { provider: result.model.provider, modelId: result.model.id, effort: result.effort } : undefined;
          },
        });
      }
      if (!answers) return undefined;

      saveUserDefaults(answers);
      store.ensure();
      store.saveProject(answers);
      if (mode === "settings") {
        const state = active?.run.state ?? store.loadState();
        if (state) {
          state.settings = runSettings(answers);
          store.saveState(state);
        }
      }

      let webAccess = webAccessInstalled;
      if (mode !== "roles" && answers.research === "install-web-access" && !webAccessInstalled) {
        ctx.ui.notify("Installing pi-web-access for research (pi install npm:pi-web-access)…", "info");
        const res = await installWebAccess();
        if (res.ok) {
          webAccess = true;
          answers.research = "web-access";
          store.saveProject(answers);
          ctx.ui.notify("pi-web-access installed. Workers use it now; run /reload to use it in this session too.", "info");
        } else {
          ctx.ui.notify(`Could not install pi-web-access (${truncate(res.output, 160)}). Research continues without web tools.`, "warning");
        }
      }
      return { answers, webAccess };
    };

    const startNew = async (ctx: ExtensionContext, cwd: string, idea: string, opts: { forceDefaults?: boolean; autonomy?: Autonomy } = {}): Promise<void> => {
      if (active) {
        ctx.ui.notify("A factory run is already active in this session. /factory pause first.", "warning");
        return;
      }
      if (ctx.modelRegistry.getAvailable().length === 0) {
        ctx.ui.notify("No models are logged in. Run /login for any provider, then /factory new.", "error");
        return;
      }
      const store = new FactoryStore(cwd);
      const previous = store.loadState();
      if (previous && previous.status !== "done") {
        const ok = await ctx.ui.confirm("Start a new run?", `A ${previous.phase} run (${previous.runId}) is not finished here. Archive it and start over?`);
        if (!ok) return;
      }
      const setup = await quickSetup(ctx, cwd, idea, opts.forceDefaults);
      if (!setup) {
        ctx.ui.notify("Factory setup cancelled.", "info");
        return;
      }
      if (previous) store.archiveState(previous.runId);
      if (opts.autonomy) setup.answers.autonomy = opts.autonomy;
      const state = newState(idea, makeRunId(), setup.answers);
      state.settings = runSettings(setup.answers);
      store.saveState(state);
      ctx.ui.notify(`Factory started (${AUTONOMY_TEXT[setup.answers.autonomy]}). /factory status any time.`, "info");
      await follow(ctx, startRun(ctx, cwd, setup.answers, state, setup.webAccess));
    };

    const resume = async (ctx: ExtensionContext): Promise<void> => {
      if (active) {
        ctx.ui.notify("The factory is already running.", "info");
        return;
      }
      const store = new FactoryStore(ctx.cwd);
      const state = store.loadState();
      if (!state) {
        ctx.ui.notify("No factory run in this folder. Start one with /factory new.", "info");
        return;
      }
      if (state.status === "done") {
        ctx.ui.notify("That run is finished. Start another with /factory new.", "info");
        return;
      }
      const project = store.loadProject();
      const names = toolNames(pi);
      const answers = defaultAnswers(
        { cwd: ctx.cwd, toolNames: names, budget: { usd: state.budgetUsd, tokens: state.budgetTokens, priced: true, size: "small" }, deployTargets: [] },
        loadUserDefaults(),
        project,
      );
      // The lock's snapshot wins over today's defaults so a resumed run reproduces
      // its own setup; the team (preset/pins) still follows the user's current defaults.
      if (state.settings) {
        const snapshot = state.settings;
        if (snapshot.autonomy !== undefined) answers.autonomy = snapshot.autonomy;
        if (snapshot.projectMode !== undefined) answers.projectMode = snapshot.projectMode;
        if (snapshot.stack !== undefined) answers.stack = snapshot.stack;
        if (snapshot.research !== undefined) answers.research = snapshot.research;
        if (snapshot.deploy !== undefined) answers.deploy = snapshot.deploy;
        if (snapshot.deployTarget !== undefined) answers.deployTarget = snapshot.deployTarget;
        if (snapshot.integrations !== undefined) answers.integrations = integrationSettings(snapshot.integrations);
      }
      const webAccess = detectWebAccess(names) || answers.research === "web-access";
      ctx.ui.notify(`Resuming ${state.runId} at ${state.phase}.`, "info");
      await follow(ctx, startRun(ctx, ctx.cwd, answers, state, webAccess));
    };

    const doctor = async (ctx: ExtensionContext, probe: boolean): Promise<void> => {
      const user = loadUserDefaults();
      const team = teamFor(ctx, { teamPreset: user.teamPreset ?? "balanced", pins: user.pins ?? {} });
      const available = ctx.modelRegistry.getAvailable();
      ctx.ui.notify("Checking your setup…", "info");
      const lines = await runDoctor({
        cwd: ctx.cwd,
        team,
        availableCount: available.length,
        providers: [...new Set(available.map((m) => m.provider))],
        webAccess: detectWebAccess(toolNames(pi)),
        integrations: new FactoryStore(ctx.cwd).loadProject()?.integrations ?? user.integrations,
        availableTools: toolNames(pi),
      });
      if (probe) {
        ctx.ui.notify("Probing each team model with one tool call…", "info");
        lines.push(...(await probeModels(team, runner, path.join(os.tmpdir(), "pi-factory-probe-sessions"))));
      }
      pi.appendEntry(TAG, { kind: "doctor", lines: formatDoctor(lines) });
    };

    // -- session lifecycle -------------------------------------------------------

    pi.on("session_start", async (_event, ctx) => {
      const state = new FactoryStore(ctx.cwd).loadState();
      if (!state || state.status === "done") return;
      ctx.ui.setStatus(TAG, `🏭 ${state.phase} (${state.status === "running" ? "interrupted" : state.status})`);
      if (!ctx.hasUI) return;
      try {
        const choice = await ctx.ui.select("Factory", ["Resume the run now", "Show status", "Not now"]);
        if (choice === "Resume the run now") await resume(ctx);
        else if (choice === "Show status") pi.appendEntry(TAG, { kind: "status", lines: stateSummary(state) });
      } catch {
        ctx.ui.notify(`A factory run is in progress here (${state.phase}). /factory resume to continue.`, "info");
      }
    });

    pi.on("session_shutdown", async () => {
      active?.controller.abort();
    });

    pi.on("before_agent_start", async (event) => {
      const options = event.systemPromptOptions;
      if (!options?.sections) return;
      if (!active) {
        delete options.sections[TAG];
        return;
      }
      const state = active.run.state;
      options.sections[TAG] = [
        "A pi software factory run is active in this project (managed by the /factory command).",
        `Phase: ${state.phase}. Project state lives in .factory/ and the build happens in ${state.worktree ?? ".factory/worktrees/"}.`,
        "Do not edit files under .factory/ or the factory worktree yourself; the user controls the run with /factory commands.",
      ].join("\n");
    });

    // -- command ----------------------------------------------------------------

    const SUBCOMMANDS = ["new", "resume", "pause", "status", "board", "tasks", "agents", "spec", "integrations", "cost", "trace", "history", "qa", "retro", "doctor", "team", "roles", "autonomy", "settings", "run", "demo", "help"];

    pi.registerCommand("factory", {
      description: "Software factory: turn an idea into a tested, documented project with a team of models",
      getArgumentCompletions: (prefix: string) => {
        const [first, second] = prefix.split(/\s+/);
        if (second !== undefined) {
          if (first === "autonomy") return ["auto", "balanced", "careful"].filter((v) => v.startsWith(second)).map((v) => ({ value: `autonomy ${v}`, label: v }));
          if (first === "team") return ["balanced", "cheap", "best", "refresh"].filter((v) => v.startsWith(second)).map((v) => ({ value: `team ${v}`, label: v }));
          if (first === "history" || first === "tasks") {
            const state = new FactoryStore(active?.cwd ?? process.cwd()).loadState();
            const items = (state?.tickets.map((t) => t.id) ?? []).filter((v) => v.startsWith(second)).map((v) => ({ value: `${first} ${v}`, label: v }));
            return items.length ? items : null;
          }
          if (first === "trace") {
            // The completion callback has no ctx; the active run's folder, else cwd.
            const state = new FactoryStore(active?.cwd ?? process.cwd()).loadState();
            const values = [...(state?.tickets.map((t) => t.id) ?? []), ...rolesFor(active?.cwd ?? process.cwd()).keys()];
            const items = values.filter((v) => v.startsWith(second)).map((v) => ({ value: `trace ${v}`, label: v }));
            return items.length ? items : null;
          }
          return null;
        }
        const items = SUBCOMMANDS.filter((s) => s.startsWith(first ?? "")).map((value) => ({ value, label: value }));
        return items.length ? items : null;
      },
      handler: async (args, ctx) => {
        const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const trimmed = args.trim();
        const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
        const rest = trimmed.slice(sub.length).trim();

        switch (sub) {
          case "help": {
            pi.appendEntry(TAG, {
              kind: "status",
              lines: [
                "/factory new [idea] — quick setup, then the whole flow",
                "/factory status · board · tasks [id] · agents · cost · trace [ticket|role] · history [ticket] — inspect the run",
                "/factory spec — read the full specification in the CLI",
                "/factory integrations — configure Paper, OpenDesign, Doop, and Brave QA",
                "/factory qa [round] · retro — exploratory QA reports, new-contributor check, retrospective",
                "/factory pause · resume — stop after this step / continue (also after restarting pi)",
                "/factory doctor [probe] · team [preset] · roles · autonomy <p> · settings · run <role> <brief> · demo",
              ],
            });
            return;
          }

          case "": {
            if (!ctx.hasUI) {
              await handler("status", ctx);
              return;
            }
            let selected = 0;
            for (;;) {
              const state = active?.run.state ?? new FactoryStore(ctx.cwd).loadState();
              const items = [
                "Task list", "Subagent list", "View specification", "Board", "Settings", "Role models", "Design and browser integrations",
                ...(state && state.status !== "done" ? [active ? "Pause the run" : "Resume the run"] : []),
                "Doctor (check setup)", "Start a new project", "Close",
              ];
              const choice = await selectFactoryMenu(ctx, "Factory", items, selected);
              if (!choice || choice === "Close") return;
              selected = Math.max(0, items.indexOf(choice));
              const command = ({ "Task list": "tasks", "Subagent list": "agents", "View specification": "spec", "Board": "board", "Settings": "settings", "Role models": "roles", "Design and browser integrations": "integrations", "Doctor (check setup)": "doctor" } as Record<string, string>)[choice];
              if (command) await handler(command, ctx);
              else if (choice === "Start a new project") { await handler("new", ctx); return; }
              else { await handler(choice === "Pause the run" ? "pause" : "resume", ctx); return; }
            }
          }

          case "new": {
            const idea = rest || (await ctx.ui.input("What should the factory build?", "e.g. a habit tracker with a web UI and a REST API"))?.trim();
            if (!idea) return;
            await startNew(ctx, ctx.cwd, idea);
            return;
          }

          case "resume":
            await resume(ctx);
            return;

          case "pause": {
            if (!active) {
              ctx.ui.notify("No factory run is active.", "info");
              return;
            }
            active.controller.abort();
            ctx.ui.notify("Pausing after the current step…", "info");
            return;
          }

          case "status": {
            const state = active?.run.state ?? new FactoryStore(ctx.cwd).loadState();
            if (!state) {
              ctx.ui.notify("No factory run in this folder.", "info");
              return;
            }
            pi.appendEntry(TAG, { kind: "status", lines: stateSummary(state) });
            return;
          }

          case "board": {
            const state = active?.run.state ?? new FactoryStore(ctx.cwd).loadState();
            if (!state) {
              ctx.ui.notify("No factory run in this folder.", "info");
              return;
            }
            pi.appendEntry(TAG, { kind: "status", lines: boardLines(state, { workers: active?.run.workerSnapshots() }) });
            return;
          }

          case "spec": {
            const spec = new FactoryStore(ctx.cwd).read("spec/spec.md");
            if (!spec) { ctx.ui.notify("No specification draft yet. Start or resume the factory to write it.", "info"); return; }
            await makeUi(pi, ctx).viewSpec!(spec);
            return;
          }

          case "tasks": {
            const state = active?.run.state ?? new FactoryStore(ctx.cwd).loadState();
            const lines = state ? taskLines(state, rest || undefined) : ["No factory run in this folder."];
            pi.appendEntry(TAG, { kind: "tasks", lines });
            if (ctx.hasUI) await showSpecViewer(ctx, "Factory tasks", "```text\n" + lines.join("\n") + "\n```");
            return;
          }

          case "agents": {
            const store = new FactoryStore(ctx.cwd);
            const lines = agentLines(active?.run.state ?? store.loadState(), active?.run.workerSnapshots() ?? [], store.readLedger());
            pi.appendEntry(TAG, { kind: "agents", lines });
            if (ctx.hasUI) await showSpecViewer(ctx, "Factory subagents", "```text\n" + lines.join("\n") + "\n```");
            return;
          }

          case "integrations": {
            const store = new FactoryStore(ctx.cwd);
            const answers = defaultAnswers({ cwd: ctx.cwd, toolNames: toolNames(pi), budget: { usd: 0, tokens: 0, priced: false, size: "small" }, deployTargets: [] }, loadUserDefaults(), store.loadProject());
            if (!ctx.hasUI) { pi.appendEntry(TAG, { kind: "status", lines: formatDoctor(integrationDiagnostics(answers.integrations, ctx.cwd, toolNames(pi))) }); return; }
            const integrations = await runIntegrationSetup(answers.integrations, makeUi(pi, ctx), toolNames(pi));
            if (integrations) {
              // Resolve bridge paths before workers move into their own worktrees.
              for (const bridge of Object.values(integrations.design ?? {})) if (bridge) bridge.extensions = bridge.extensions?.map(file => path.resolve(ctx.cwd, file));
              if (integrations.browser?.extensions) integrations.browser.extensions = integrations.browser.extensions.map(file => path.resolve(ctx.cwd, file));
              answers.integrations = integrations;
              store.saveProject(answers);
              // Explicit settings changes update a paused run's snapshot for resume.
              const state = active?.run.state ?? store.loadState();
              if (state && state.settings) { state.settings.integrations = integrations; store.saveState(state); }
              ctx.ui.notify("Integrations saved for this folder. Active workers keep their current tools.", "info");
            }
            return;
          }

          case "cost": {
            const store = new FactoryStore(ctx.cwd);
            const entries = store.readLedger();
            const runId = (active?.run.state ?? store.loadState())?.runId;
            const user = loadUserDefaults();
            const team = teamFor(ctx, { teamPreset: user.teamPreset ?? "balanced", pins: user.pins ?? {} });
            const frontierModel = team.tiers.frontier;
            const frontier = frontierModel
              ? {
                  inPerToken: (frontierModel.cost?.input ?? 0) / 1e6,
                  outPerToken: (frontierModel.cost?.output ?? 0) / 1e6,
                  blendedPerToken: pricePerToken(frontierModel),
                }
              : undefined;
            const report = buildCostReport(entries, { runId, frontier });
            if (!report.workerRuns) {
              ctx.ui.notify("Nothing spent yet in this folder.", "info");
              return;
            }
            const lines = [runId ? `cost for run ${runId}` : "cost, all runs", ...renderCostReport(report)];
            const hidden = runId ? entries.filter((e) => e.kind === "worker" && e.runId !== runId).length : 0;
            if (hidden > 0) lines.push(`other runs: ${hidden} worker run(s) not shown (start a run to filter)`);
            pi.appendEntry(TAG, { kind: "status", lines });
            return;
          }

          case "history": {
            const store = new FactoryStore(ctx.cwd);
            const state = active?.run.state ?? store.loadState();
            if (!state) {
              ctx.ui.notify("No factory run in this folder.", "info");
              return;
            }
            const entries = store.readLedger();
            const lines = rest ? ticketHistory(entries, rest, state.runId) : historyOverview(entries, state.tickets, state.runId);
            pi.appendEntry(TAG, { kind: "status", lines });
            return;
          }

          case "qa": {
            const store = new FactoryStore(ctx.cwd);
            let rounds: string[] = [];
            try {
              rounds = fs.readdirSync(store.path("qa")).filter((f) => /^round-\d+\.md$/.test(f));
            } catch {
              /* no QA yet */
            }
            rounds.sort((x, y) => Number(x.match(/\d+/)![0]) - Number(y.match(/\d+/)![0]));
            const wanted = rest ? `round-${Number.parseInt(rest, 10)}.md` : rounds.at(-1);
            const qa = wanted ? store.read(`qa/${wanted}`) : undefined;
            const contributor = store.read("contributor.md");
            if (!qa && !contributor) {
              ctx.ui.notify(rest ? `No QA report for round ${rest}.` : "No exploratory QA or new-contributor check has run in this folder yet.", "info");
              return;
            }
            const lines = [...(qa ? qa.trimEnd().split("\n") : []), ...(qa && contributor ? [""] : []), ...(contributor ? contributor.trimEnd().split("\n") : [])];
            if (rounds.length > 1 && !rest) lines.push("", `${rounds.length} rounds: /factory qa <n> shows an earlier one`);
            pi.appendEntry(TAG, { kind: "status", lines });
            return;
          }

          case "retro": {
            const store = new FactoryStore(ctx.cwd);
            const retro = store.read("retro.md");
            if (!retro) {
              ctx.ui.notify("No retrospective yet; it is written when a run releases.", "info");
              return;
            }
            pi.appendEntry(TAG, { kind: "status", lines: retro.trimEnd().split("\n") });
            return;
          }

          case "trace": {
            const arg = rest;
            const store = new FactoryStore(ctx.cwd);
            const entries = store.readLedger();
            const runId = (active?.run.state ?? store.loadState())?.runId;
            const workers = entries.filter((e) => e.kind === "worker" && (runId === undefined || e.runId === runId));
            const candidates = arg ? workers.filter((e) => e.ticket === arg || e.role === arg) : workers;
            const entry = [...candidates].reverse().find((e) => Array.isArray(e.trace) && e.trace.length > 0);
            if (!entry) {
              ctx.ui.notify(arg ? `No traced worker run found for "${arg}".` : "No traced worker runs yet.", "info");
              return;
            }
            pi.appendEntry(TAG, {
              kind: "trace",
              role: entry.role,
              model: entry.model,
              ticket: entry.ticket,
              at: entry.at,
              steps: entry.trace,
            });
            return;
          }

          case "doctor":
            await doctor(ctx, rest === "probe");
            return;

          case "team": {
            const user = loadUserDefaults();
            if (["balanced", "cheap", "best"].includes(rest)) {
              const answers = { ...defaultAnswers({ cwd: ctx.cwd, toolNames: [], budget: { usd: 0, tokens: 0, priced: false, size: "small" }, deployTargets: [] }, user, null), teamPreset: rest as TeamPreset };
              saveUserDefaults(answers);
              user.teamPreset = rest as TeamPreset;
            }
            const team = teamFor(ctx, { teamPreset: user.teamPreset ?? "balanced", pins: user.pins ?? {} });
            pi.appendEntry(TAG, {
              kind: "status",
              lines: [
                `team preset: ${user.teamPreset ?? "balanced"}`,
                ...Object.values(team.members).map((m) => `${m.role}: ${m.provider}/${m.modelId}${m.effort ? ` (${m.effort})` : ""} · ${m.tier}`),
                ...team.notes.map((n) => `! ${n}`),
              ],
            });
            if (active && rest) ctx.ui.notify("The running build keeps its team; the change applies to the next run or resume.", "info");
            return;
          }

          case "roles": {
            if (!ctx.hasUI) {
              await handler("team", ctx);
              return;
            }
            const setup = await quickSetup(ctx, ctx.cwd, new FactoryStore(ctx.cwd).loadState()?.idea ?? "", false, "roles");
            if (setup) ctx.ui.notify("Role models saved. Changes apply on the next run or resume.", "info");
            return;
          }

          case "autonomy": {
            const value = rest as Autonomy;
            if (!["auto", "balanced", "careful"].includes(value)) {
              ctx.ui.notify("Usage: /factory autonomy auto|balanced|careful", "info");
              return;
            }
            const store = new FactoryStore(ctx.cwd);
            const user = loadUserDefaults();
            const project = store.loadProject();
            const answers = defaultAnswers({ cwd: ctx.cwd, toolNames: [], budget: { usd: 0, tokens: 0, priced: false, size: "small" }, deployTargets: [] }, user, project);
            answers.autonomy = value;
            saveUserDefaults(answers);
            if (project) store.saveProject({ ...(project as SetupAnswers), autonomy: value });
            // Live update: the running pipeline reads answers.autonomy at each gate,
            // and the lock's settings snapshot is refreshed so a resume keeps it.
            if (active) {
              const run = active.run as any;
              run.deps.answers.autonomy = value;
              active.run.state.settings = { ...runSettings(run.deps.answers as SetupAnswers), autonomy: value };
              store.saveState(active.run.state);
            }
            ctx.ui.notify(`Autonomy: ${AUTONOMY_TEXT[value]}`, "info");
            return;
          }

          case "settings": {
            if (!ctx.hasUI) {
              ctx.ui.notify("Open /factory settings in an interactive session to change settings.", "info");
              return;
            }
            const setup = await quickSetup(ctx, ctx.cwd, new FactoryStore(ctx.cwd).loadState()?.idea ?? "", false, "settings");
            if (setup) ctx.ui.notify("Factory settings saved for this folder.", "info");
            return;
          }

          case "run": {
            const [roleName, ...briefParts] = rest.split(/\s+/);
            const brief = briefParts.join(" ").trim();
            const roles = rolesFor(ctx.cwd);
            const role = roles.get(roleName ?? "");
            if (!role || !brief) {
              ctx.ui.notify(`Usage: /factory run <role> <brief>. Roles: ${[...roles.keys()].join(", ")}`, "info");
              return;
            }
            const user = loadUserDefaults();
            const team = teamFor(ctx, { teamPreset: user.teamPreset ?? "balanced", pins: user.pins ?? {} });
            const member = team.members[role.name];
            if (!member) {
              ctx.ui.notify("No model available for that role. Run /login.", "error");
              return;
            }
            ctx.ui.notify(`${role.name} (${member.provider}/${member.modelId}) is working…`, "info");
            const result = await runner.run({
              role: role.name,
              member,
              tools: role.tools.filter((t) => !["edit", "write"].includes(t)),
              systemPrompt: role.systemPrompt,
              prompt: brief,
              cwd: ctx.cwd,
              sessionId: `adhoc-${role.name}-${Date.now()}`,
              sessionDir: path.join(os.tmpdir(), "pi-factory-adhoc"),
              writeScope: [],
              timeoutMs: 20 * 60_000,
              signal: ctx.signal,
            });
            pi.appendEntry(TAG, {
              kind: "worker",
              role: role.name,
              model: result.model,
              text: result.isError ? `failed: ${result.errorMessage}` : result.text,
              meta: `${result.turns} turns · ${formatTokens(result.usage.totalTokens)} tok · ${formatCost(result.usage.cost.total)}`,
              trace: result.trace,
            });
            return;
          }

          case "demo": {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-demo-"));
            ctx.ui.notify(`Demo: building a tiny to-do CLI in ${dir} (autonomy: auto).`, "info");
            await startNew(ctx, dir, DEMO_IDEA, { forceDefaults: true, autonomy: "auto" });
            return;
          }

          default:
            ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "info");
        }
        };
        const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const modal = ["", "new", "settings", "roles", "integrations", "spec", "tasks", "agents", "demo"].includes(subcommand);
        if (ctx.hasUI && modal) await dialogLock.run(() => handler(args, ctx));
        else await handler(args, ctx);
      },
    });

    // -- transcript rendering ---------------------------------------------------

    pi.registerEntryRenderer(TAG, (entry, { expanded }, theme) => {
      const data = (entry.data ?? {}) as Record<string, any>;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const head = (label: string) => `${theme.bold("🏭 factory")} ${theme.fg("accent", label)}`;
      switch (data.kind) {
        case "phase":
          box.addChild(new Text(`${head("phase")} ${theme.fg("toolOutput", String(data.phase))}`, 0, 0));
          break;
        case "gates":
          box.addChild(new Text(`${head("gates")} ${data.ok ? theme.fg("success", "passed") : theme.fg("error", "failed")} ${theme.fg("dim", String(data.summary ?? ""))}`, 0, 0));
          break;
        case "ticket":
          box.addChild(new Text(`${head("ticket")} ${theme.fg("success", "✓")} ${data.id} ${data.title} ${theme.fg("dim", `(${data.attempts} attempt(s))`)}`, 0, 0));
          break;
        case "approval":
          box.addChild(new Text(`${head("approval")} ${String(data.title)}`, 0, 0));
          if (expanded) box.addChild(new Text(theme.fg("dim", String(data.summary ?? "")), 0, 0));
          break;
        case "report": {
          const text = String(data.text ?? "");
          box.addChild(new Text(head("report"), 0, 0));
          const lines = text.split("\n");
          for (const line of expanded ? lines : lines.slice(0, 8)) box.addChild(new Text(line, 0, 0));
          if (!expanded && lines.length > 8) box.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "to expand")), 0, 0));
          break;
        }
        case "worker": {
          box.addChild(new Text(`${head(String(data.role))} ${theme.fg("dim", `${data.model} · ${data.meta}`)}`, 0, 0));
          box.addChild(new Text(String(data.text ?? ""), 0, 0));
          const trace = Array.isArray(data.trace) ? data.trace : [];
          if (expanded) for (const line of renderTraceSteps(trace, theme)) box.addChild(new Text(line, 0, 0));
          else if (trace.length) box.addChild(new Text(theme.fg("dim", `${trace.length} trace steps · ${keyHint("app.tools.expand", "to expand")}`), 0, 0));
          break;
        }
        case "trace": {
          const steps = Array.isArray(data.steps) ? data.steps : [];
          const meta = [data.role, data.model, data.ticket, data.at].filter(Boolean).join(" · ");
          box.addChild(new Text(`${head("trace")} ${theme.fg("dim", String(meta))}`, 0, 0));
          if (expanded) for (const line of renderTraceSteps(steps, theme)) box.addChild(new Text(line, 0, 0));
          else box.addChild(new Text(theme.fg("dim", `${steps.length} trace steps · ${keyHint("app.tools.expand", "to expand")}`), 0, 0));
          break;
        }
        default: {
          box.addChild(new Text(head(String(data.kind ?? "")), 0, 0));
          for (const line of Array.isArray(data.lines) ? data.lines : []) box.addChild(new Text(String(line), 0, 0));
        }
      }
      return box;
    });
  };
}

export default createFactoryExtension();
