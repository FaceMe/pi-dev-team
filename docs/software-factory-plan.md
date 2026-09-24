# pi Software Factory: review and implementation plan

This document reviews the current `pi-model-picker` package, then describes how to
turn it into a **software factory**. The factory is a team of role-specialised
agents running inside [pi](https://github.com/badlogic/pi-mono). It works with you
to pin down requirements, researches, designs, builds, tests, documents and
releases maintainable software. Each kind of work runs on the model best suited to
it.

It builds on the ideas in Cognition's
[Devin Fusion](https://cognition.com/blog/devin-fusion) post, which the existing
`fusion` extension already implements in part.

- Status: **M0 and M1 implemented** (see [Implementation status](#implementation-status)); M2–M7 planned
- Scope: this repository (pi extension package)
- Last updated: 2026-09-24

---

## Implementation status

| Milestone | State | Notes |
|---|---|---|
| M0 hygiene | Done | Code split into `extensions/*/index.ts` + `src/`; one config module (`src/shared/config.ts`); bugs B1–B9 fixed plus B10 (the sidekick turn cap never worked: `shouldStopAfterTurn` is not an `Agent` option; now `finishTurn`); tsconfig, vitest, CI; v2.0.0 |
| M1 quick-start slice | Done | `/factory` with quick setup, automatic team from any provider, interview, spec, architecture, plan, skeleton, test-first build with gates and cross-family review, escalation, docs, merge, report, budget breaker, pause/resume, doctor, demo, headless mode |
| M2–M7 | Planned | Parallel tickets, deeper discovery (brainstorm fan-out, readiness scoring), profile templates, QA role, deploy hardening, benchmarks |

Verification: 71 tests, including the whole pipeline with **real `pi` worker
processes** against a mock OpenAI-compatible model, and the real `/factory new`
command run headless in a pi session.

Decisions made while building M1:

- **Runner: option C** (a `pi --mode json` subprocess per worker, §6.3), with
  a persistent pi session per role and ticket (`--session-id`). It loads the
  user's providers and extensions — needed for pi-web-access research — keeps
  context and cache between calls, and isolates crashes. The write-scope guard
  runs *inside* each worker as a `tool_call` hook (this package detects
  `PI_FACTORY_WORKER=1`), and the harness re-checks the diff after each attempt.
- **Setup questions are all asked up front, prefilled** (§5.1): team, autonomy,
  project mode (new or existing, detected), stack (architect's choice or the
  detected stack), web research (pi-web-access, offered for install), deployment
  (local / config / deploy with a detected logged-in CLI), and budget (estimated
  from the team's prices and the idea's size). Enter accepts all.
- **Existing repositories are supported from M1** (architect keeps the stack,
  skeleton only adds missing tooling, merge returns to the user's branch).
- **QA-first tests are written by the builder** in M1 (test-first prompt, gates
  enforce); a separate QA role arrives with parallel tickets (M5).

## Contents

1. [Summary](#1-summary)
2. [Review of the current implementation](#2-review-of-the-current-implementation)
3. [What we take from Devin Fusion, and where the factory goes further](#3-what-we-take-from-devin-fusion-and-where-the-factory-goes-further)
4. [Goals and non-goals](#4-goals-and-non-goals)
5. [Quick start and onboarding](#5-quick-start-and-onboarding)
6. [Architecture](#6-architecture)
7. [The team: roles and model assignment](#7-the-team-roles-and-model-assignment)
8. [Lifecycle: phases, gates and artifacts](#8-lifecycle-phases-gates-and-artifacts)
9. [Discovery: brainstorming and requirement gathering with you](#9-discovery-brainstorming-and-requirement-gathering-with-you)
10. [The build loop](#10-the-build-loop)
11. [How the factory keeps software maintainable](#11-how-the-factory-keeps-software-maintainable)
12. [Artifact store and data model](#12-artifact-store-and-data-model)
13. [User experience: commands, tools and UI](#13-user-experience-commands-tools-and-ui)
14. [Configuration](#14-configuration)
15. [Safety, cost and failure handling](#15-safety-cost-and-failure-handling)
16. [Repository restructure](#16-repository-restructure)
17. [Implementation milestones](#17-implementation-milestones)
18. [Testing and evaluating the factory](#18-testing-and-evaluating-the-factory)
19. [Risks](#19-risks)
20. [Open questions](#20-open-questions)

---

## 1. Summary

The package ships two extensions today. The **model picker** handles roles and
reasoning effort. **Fusion** pairs a frontier main agent with a cheaper sidekick
and routes between models mid-session. Together they supply the factory's two
lowest layers: a vocabulary for choosing models, and a proven way to run a
second, cheaper agent with its own persistent context.

The factory adds five layers on top:

1. **A role registry.** Agents such as researcher, architect, backend, frontend,
   devops, QA, reviewer and docs are defined as Markdown files. Each one declares
   its model tier, reasoning effort, tools and write scope.
2. **An orchestrator.** It drives a gated lifecycle: discovery, spec,
   architecture, plan, build, integrate, release. Every gate stops for your
   approval (configurable).
3. **A file-based artifact store** under `.factory/` in the target repository. It
   holds the spec, architecture decision records (ADRs), tickets, decisions and
   the traceability matrix, so the process can be resumed, reviewed and
   version-controlled.
4. **A build loop.** Each ticket is implemented test-first in its own git
   worktree, checked by deterministic gates (build, typecheck, lint, tests), and
   reviewed by a second model (from a different family when one is available)
   before it merges.
5. **Cost and model governance.** This generalises Fusion's routing, escalation
   and accounting from one sidekick to a whole team.

The guiding rule comes from the Fusion post: **the frontier model keeps the
judgement; everything mechanical is delegated and verified.** The factory applies
it at team scale, and adds the part the post leaves out: verification comes from
tools and tests, not from agents vouching for their own work.

Two requirements shape every design choice (§5):

- **Quick onboarding.** Install, type `/factory new "<idea>"`, and the first
  interview question arrives within about two minutes. No configuration files to
  write: the factory detects your models, proposes a team on one screen, and
  starts.
- **Any provider pi supports.** Built-in APIs, subscription logins, custom
  providers and local models all work, in any combination. Nothing is tied to a
  provider name or model ID. The team is derived from whatever models you have
  logged in, and you can change any part of it.

Autonomy is configurable with three presets. The default, `balanced`, asks for
two approvals per project.

---

## 2. Review of the current implementation

### 2.1 What is there

| File | Size | What it does |
|---|---|---|
| `extensions/model-picker.ts` | ~2.3k lines | Two-panel TUI model picker; `daily` / `small` / `frontier` roles; reasoning-effort picker clamped to what each model supports; assigns the Fusion main and sidekick slots; `/effort`, `/role`, `/default`, `/exit` |
| `extensions/fusion.ts` | ~2.2k lines | `FusionEngine`: a persistent in-process sidekick `Agent` (from `pi-agent-core`) with its own tools; a `sidekick` delegation tool; LLM or heuristic routing at compaction; escalation after repeated failures; cost and savings ledger; on-demand delegation traces |
| ~~`extensions/qwen.ts`~~ | — | Removed at your request (commit `824692f`) |

### 2.2 Strengths worth keeping

- **Fusion's core design is right.** The sidekick keeps a persistent transcript,
  a stable system prompt and stable tool declarations, so its prefix can be
  cached. Model switches happen at compaction boundaries, where the cache is
  lost anyway. That matches the post's reasoning.
- **The delegation discipline prompt** (`buildMainGuidance`, `fusion.ts:658`)
  spells out what to delegate and what not to. This carries over unchanged into
  the orchestrator's prompt.
- **Traces** (`buildTrace`, `fusion.ts:434`) keep thinking, tool calls and output
  excerpts within bounds, stored in tool-result `details`, so they survive a
  reload. The factory needs this kind of observability for every agent.
- **Effort handling is capability-aware.** It goes through `clampThinkingLevel`
  and `getSupportedThinkingLevels` everywhere, so assigning a role never produces
  an invalid thinking level.
- **The model picker is reusable.** `showModelPicker(ctx, pi, { target })`
  already returns `{ model, effort }` for any target, so assigning a model to a
  factory role is a small extension of it.

### 2.3 Bugs and correctness issues

Verified by reading the code; line numbers refer to the current branch.

| # | Location | Issue | Impact |
|---|---|---|---|
| B1 | `fusion.ts:1176`, `fusion.ts:1200` | `applyRouting` takes `current` for the main slot from `resolveMainModel()`, the *configured* slot, but an applied main route only calls `pi.setModel` and never updates `config.main`. | After a single routed downgrade (frontier→daily), the next decision still starts from frontier. A second downgrade picks daily again (it never reaches small), and an upgrade computes "already at the top" and does nothing, so **routing can never move main back up**. Fix: use the live `ctx.model` (the engine already keeps `latestCtx`) as `current`. |
| B2 | `fusion.ts:1637` | The error message calls `modelKey()` with no argument. | Always prints `(none)` instead of the missing model's name. |
| B3 | `fusion.ts:1724`, `fusion.ts:1747`, `fusion.ts:2098` | `/fusion main` and the wizard call `pi.setModel` without setting `internalModelChange` or `preFusionModel`, and switch the session model even when Fusion is **off**. | Extension `setModel` most likely emits `model_select` with `source: "set"`, which marks `userPickedModel` and quietly turns off main-slot routing for the rest of the session. `/fusion off` also cannot restore the model that was active before. |
| B4 | `fusion.ts:837`, `fusion.ts:1351` | Choosing a sidekick model by hand (picker, command or event) goes through `setSidekickModel`, which records a `fusion-sidekick` *routing* entry in the session. | A deliberate choice is treated as a routing decision and replayed on resume by `restoreRoutedSidekick`, where it overrides `fusion.json`. |
| B5 | `fusion.ts:552` | `buildTranscript` keeps a user message only when `content` is a string. | User turns sent as content arrays (images, attachments, some RPC clients) never reach the routing classifier. |
| B6 | `model-picker.ts:321-360` | `loadRolesState()` **writes** `model-roles.json` when the file is missing, seeded with outdated model IDs (`claude-3-7-sonnet`, `claude-3-5-haiku`, `gpt-4o-mini`). | Reading has a side effect, and the stale IDs then seed Fusion (`loadConfig`, `fusion.ts:614`). |
| B7 | `model-picker.ts:192-247` vs `fusion.ts:593` | `fusion.json` has two independent loaders and writers with different defaults and schemas, kept in step by a `fusion_config_updated` event that both extensions emit *and* listen to. | Easy to drift apart; a write from one extension can race a write from the other. `model-picker.ts` also reimplements `getAgentDir` instead of importing pi's. |
| B8 | `fusion.ts:1020` | `trimSidekickTranscript` keeps messages with `role === "system"`, but agent transcripts contain no such role. | Dead code, and a misleading comment. |
| B9 | `README.md:12` | The install line pins `@v1.4.0`, but `package.json` is at `1.5.0`. | Users install an outdated tag. |

### 2.4 Structural gaps that matter for the factory

- **No tests, no typecheck config, no lint, no CI.** There is no `tsconfig.json`,
  and the peer packages are not installed as dev dependencies. A factory whose
  promise is maintainable software has to meet that bar itself first.
- **Very large single files.** Each extension is about 2.2k lines, mixing
  config I/O, engine logic, TUI and command wiring. The factory would add much
  more, so modules and shared libraries are needed first (§16).
- **One sidekick, one queue.** `FusionEngine.delegate` runs delegations one at a
  time on a single agent. A team needs a *pool* of agents keyed by role and
  ticket, with parallel work where write scopes do not overlap.
- **No write-scope control.** A sidekick given `edit`/`write`/`bash` can touch any
  file. Parallel builders need per-ticket path scopes enforced at the tool layer.
- **Durable state is limited to configuration and a stats ledger.** Nothing
  records requirements, decisions or plans, and nothing lets a multi-day process
  resume.
- **The estimated savings are optimistic.** `calculateCost(mainModel, usage)`
  prices the *sidekick's* tokens at main-model rates. The main model would have
  needed different tokens (more context, fewer turns). Keep the number, but label
  it as an estimate, and in the factory prefer outcome metrics such as cost per
  merged ticket.

### 2.5 Verdict

The repository is a solid proof of concept for the Fusion pattern and a good
model-selection UX. It is not yet a base to build a factory on. It needs a short
hygiene pass first (bugs B1–B9, module split, tooling). Milestone M0 in §17 covers
that.

---

## 3. What we take from Devin Fusion, and where the factory goes further

| Fusion idea | Status here | In the factory |
|---|---|---|
| Frontier main agent plus a cheap sidekick, each with its own tools and persistent cache | Implemented | Generalised to a **worker pool**. Every role worker has a persistent context per ticket and can have its own cheap sidekick, so the pattern works at two levels. |
| Delegation discipline: the frontier model decides, plans, interprets and reviews | Implemented as a prompt section | Becomes the orchestrator's operating contract, backed by structure: phases, gates, tickets. |
| Switch models at compaction, where the cache miss is free | Implemented (with bug B1) | Applied per worker. Tickets also escalate up a model ladder on failure (§10.4). |
| A classifier decides upgrade or downgrade | LLM or heuristic | Extended with ticket signals: attempts, failing gates, diff size, the role's risk class. |
| "Fails when the judgement is the deliverable" | Handled only in the prompt | **Enforced**: requirements, architecture, API contracts and review are pinned to frontier-tier roles and never downgraded by routing. |

Where the factory goes beyond the post:

- **Humans in the loop at the right points.** Discovery is a structured
  interview, and gates collect approval on the spec, architecture and plan.
- **Verification by tools, not by agents' word.** Tests, typecheck, lint,
  build and end-to-end checks run in the harness, and their exit codes decide.
  The Fusion prompt's "never claim success you did not verify" becomes a hard
  gate.
- **Cross-model review.** When you have more than one model family available,
  the reviewer runs on a *different family* from the author, so their errors
  are less likely to overlap.
- **Traceability.** Every requirement maps to tickets, which map to tests, which
  map to commits. That is what makes the result maintainable after the factory
  is gone.

---

## 4. Goals and non-goals

### Goals

- G1. Turn a vague idea into an approved, testable specification through a
  conversation with you: brainstorming, clarifying questions, research.
- G2. Produce working software whose acceptance tests pass, together with the
  structure, tests, docs and CI a human team needs to own it.
- G3. Use the right model for each kind of work (planning, research, backend,
  frontend, devops, docs, review) and change it as evidence comes in.
- G4. Keep cost visible and bounded: budgets per phase and per ticket, a ledger,
  and savings compared with an all-frontier run.
- G5. Keep every step resumable, inspectable and reversible: file-based state,
  git branches, traces.
- G6. Stay stack-agnostic. The workflow is fixed, and stack knowledge comes from
  pluggable **profiles**.
- G7. **Onboard in minutes.** Zero configuration files, one setup screen, and a
  working default for every choice (§5).
- G8. **Work with any provider and model pi supports**, in any mix, with the team
  derived automatically from what you have logged in.
- G9. **Configurable autonomy**, from `auto` (approve only the spec) to `careful`
  (approve every phase), switchable at any time.

### Non-goals (for v1)

- Deploying to real cloud accounts or managing production infrastructure.
  DevOps stops at containers, CI and infrastructure-as-code *files*.
- Running without pi. The factory is a pi package; running it headless through
  pi's RPC or JSON modes should work, but no separate server is built.
- Generating designs or visual assets. The frontend role works from your
  descriptions, reference screenshots or an existing design system.

---

## 5. Quick start and onboarding

Principle: **the first useful result arrives in minutes.** You never have to write
a configuration file, every choice has a working default, and advanced options
stay out of sight until you ask for them.

### 5.1 First run

```bash
pi install git:github.com/FaceMe/pi-dev-team
mkdir habit-tracker && cd habit-tracker && pi
```

```text
/factory new "a habit tracker with a web UI and a REST API"
```

What happens next:

1. **Preflight** (silent when everything is fine). It checks for git, and runs
   `git init` in an empty folder, asking first if the folder is not empty. It
   checks that at least one model is logged in and that the folder is writable.
   Anything missing gets a one-line fix, for example "no models are logged in:
   run `/login`".
2. **Automatic team** (§5.2), built from the models you have logged in.
3. **Quick setup**, one screen of questions with prefilled answers. The first
   line starts with every default, so agreeing is a single Enter:

   ```text
   Factory setup — Enter starts with these answers
   ▶ Start with these answers
     Team: balanced — analyst, architect, planner, reviewer → <A> · backend, … → <B> · docs → <C>
     Autonomy: balanced — you approve the spec and one build plan
     Project: new project in this folder            (detected: empty folder)
     Stack: let the architect choose                (existing code: "keep: <detected stack>")
     Web research: pi-web-access (web_search, fetch_content)   (or "install pi-web-access now")
     Deployment: run locally only                   (or config only, or a detected logged-in CLI)
     Budget: $15 (estimate for a small project with this team) · pauses at 80%
   ```

   Opening a line offers the alternatives (and free text where it makes sense:
   any stack, any deploy target, any budget). "Team" also lets you pin any role
   to a model with the two-panel picker. Team, autonomy and research are
   remembered in `~/.pi/agent/factory.json`; the rest per folder in
   `.factory/project.json`, and prefilled next time.
4. **Discovery starts** with the first interview question.

Targets: about **two minutes** from install to the first question, **zero** files
edited by hand, and at most **two approval screens** per project on the default
preset.

### 5.2 Automatic team from any pi provider

The factory runs on whatever pi can call: built-in API providers, subscription
logins, custom providers defined in `models.json`, and local models behind an
OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio and similar), in any
mix. The team is derived from model metadata, never from provider names or model
IDs, so new providers and models work without a factory update.

How the team is built:

1. **Candidates** come from `ctx.modelRegistry.getAvailable()`, the models with
   working credentials. The picker already uses this call to show its auth
   indicators.
2. **Your existing choices come first.** If you set `small` / `daily` /
   `frontier` roles or Fusion slots with the model picker, those are the tiers.
3. **Otherwise, each model gets a capability score** from its metadata:
   `reasoning` and the highest supported thinking level (via
   `getSupportedThinkingLevels`), `contextWindow`, `maxTokens`, image support in
   `input`, and price (`cost.input` and `cost.output`, used as a capability
   signal within a provider). Free and local models (cost 0) are ranked on the
   other signals and labelled `local` on the card.
4. **Tiers:** frontier is the highest score; small is the cheapest model with
   enough context for its roles; daily is the best value in between. With one
   model, every tier uses it; with two, small and daily share the cheaper one.
   Either way the card says so.
5. **Roles are mapped to tiers** as in §7.1. Frontend prefers models with image
   input; the reviewer prefers a different family from the builders. The family
   is guessed from the provider and model-name prefix, and it is a preference,
   never a requirement.
6. **Unknown prices** are shown as tokens instead of dollars, and the budget then
   applies to tokens.

The team keeps adapting after setup. Failover (§7.3) switches to the next-best
model in the same tier when a provider errors or hits a rate limit.
`/factory team refresh` picks up providers you log in to later. `/factory team
cheap|balanced|best` shifts every role down or up one tier (judgement roles never
go below `daily` when a stronger model exists). Any role can be pinned in the
picker.

### 5.3 Autonomy presets

| Preset | You approve | Runs on its own | Good for |
|---|---|---|---|
| `auto` | The spec | Everything after the spec, through to release; you get notifications and a final summary | Small tools, prototypes, the demo |
| `balanced` (default) | The spec, then **one build-plan screen** (architecture summary, tickets and budget together) | Build, integration, docs, release summary | Most projects |
| `careful` | Every phase gate, plus each merge to integration | Nothing past a gate | High-stakes work, or getting to know the factory |

In every preset, the budget breaker and genuine blockers still stop and ask you,
and `/factory pause` works at any time. Switch presets with `/factory autonomy
<preset>` or `a` on the setup card. Per-gate overrides exist in the config file
for anyone who wants them, but no one needs them.

### 5.4 The interview scales with the brief

- A **short or clear brief** gets one round of at most 4 questions. A larger
  brief gets up to three rounds.
- Every round offers **Use your defaults**. Unanswered items become assumptions,
  listed on the spec approval screen, where you can correct them.
- The factory does not ask about the tech stack unless you mention one. The
  architect picks from the profile defaults and records why in an ADR, which you
  see in the build plan.

### 5.5 Onboarding helpers

- `/factory doctor` checks git, the chosen profile's toolchain (Node or pnpm,
  Python or uv, Docker when needed), and each team model with a one-call
  tool-use probe costing a fraction of a cent. It prints the fix for anything
  that fails.
- `/factory demo` builds a tiny sample project (a CLI to-do app) in a temporary
  folder on `auto`, so you can see the whole flow in a few minutes for little
  cost.
- **Resume prompt:** opening pi inside a factory project offers to pick up where
  it stopped.
- The **README quick start** is three lines: install, open pi, `/factory new`.

---

## 6. Architecture

### 6.1 Component view

```
                          ┌─────────────────────────────────────────────┐
   You  ◀──── TUI ──────▶ │  ORCHESTRATOR (main pi session, frontier)    │
 (interview, approvals,   │  • phase state machine  • gate keeper        │
  board, traces)          │  • dispatches tickets    • final judgement   │
                          └───────┬──────────────┬──────────────┬────────┘
                                  │ tools        │ reads/writes │ events
               ┌──────────────────▼───┐   ┌──────▼──────┐  ┌────▼─────────┐
               │ ROLE REGISTRY        │   │ ARTIFACT    │  │ LEDGER &     │
               │ .md role definitions │   │ STORE       │  │ TRACES       │
               │ model tier / effort  │   │ .factory/   │  │ cost, usage, │
               │ tools / write scope  │   │ spec, ADRs, │  │ routes,      │
               └──────────┬───────────┘   │ tickets,    │  │ gate results │
                          │               │ decisions   │  └──────────────┘
               ┌──────────▼───────────┐   └─────────────┘
               │ MODEL ROUTER         │  role tier → model ladder → escalation
               │ (generalised Fusion) │  compaction-time re-routing
               └──────────┬───────────┘
               ┌──────────▼───────────────────────────────────────────────┐
               │ WORKER POOL  (one persistent agent per role × ticket)    │
               │  researcher  architect  backend  frontend  devops  qa    │
               │  reviewer  docs  (each can have its own Fusion sidekick) │
               └──────────┬───────────────────────────────────────────────┘
               ┌──────────▼───────────┐   ┌──────────────────────────────┐
               │ WORKSPACE MANAGER    │   │ GATE RUNNER                  │
               │ git worktree/ticket  │   │ install/build/typecheck/lint │
               │ integration branch   │──▶│ /test/e2e/coverage/audit     │
               │ merge & conflicts    │   │ deterministic, from profile  │
               └──────────────────────┘   └──────────────────────────────┘
```

### 6.2 Components

| Component | Responsibility | Built on |
|---|---|---|
| **Orchestrator** | Runs the lifecycle state machine; talks to you; turns specs into plans; dispatches tickets; makes the final accept or reject at each gate. It is the main pi session, running a frontier model with an orchestrator prompt section. | `before_agent_start` prompt sections (as Fusion does), `pi.registerTool`, `pi.setActiveTools` |
| **Role registry** | Loads role definitions from `~/.pi/agent/factory/roles/*.md` (user level) and `.factory/roles/*.md` (project level, only if the project is trusted). | The frontmatter format from pi's `subagent` example, extended (§7.2) |
| **Model router** | Resolves role → tier → concrete model; enforces model-family diversity for review; runs escalation ladders; re-routes at compaction. | Generalises `FusionEngine.ladder/classify/applyRouting`, with bug B1 fixed |
| **Worker pool** | Creates, reuses and disposes one persistent agent per (role, ticket); runs up to `maxParallel` workers at once; streams progress; captures traces and usage. | The `FusionEngine` agent lifecycle. The runner backend is decided in the M1 spike (§6.3). |
| **Workspace manager** | Creates a git worktree and branch per ticket; merges into an integration branch; detects conflicts and hands them to the orchestrator; takes checkpoints. | `pi.exec("git", …)`, ideas from pi's `git-checkpoint` example |
| **Gate runner** | Runs the profile's check commands with timeouts and captures structured results (pass or fail, failing tests, truncated logs). Only these results can mark a ticket done. | `pi.exec`, profile commands (§11.1) |
| **Artifact store** | Typed read and write access to `.factory/` (spec, ADRs, tickets, decisions, traceability), with schema validation and atomic writes. | Plain files: Markdown for people, JSON for machines |
| **Ledger and traces** | Usage and cost per agent, ticket and phase; routing records; gate history; delegation traces. | Generalises Fusion's stats and `buildTrace` |
| **Interview UI** | Structured questions with options, recommended defaults and a free-text "other"; approval dialogs; a board widget. | pi's `questionnaire` example, `ctx.ui.select/confirm/custom`, `setWidget` |

### 6.3 Runner backend (decided in M1: option C)

Workers need persistent context (for cache reuse), their own tools pointed at a
worktree, streaming progress, abort, and usage accounting. There are three
options:

| Option | Pros | Cons |
|---|---|---|
| A. `pi-agent-core` `Agent` in-process (what Fusion uses) | Proven in this repo; cheap; persistent context; we build the tools, so write-scope wrappers are easy | No built-in compaction or session persistence; one crash takes down pi |
| B. `createAgentSession` from the pi SDK, in-process | Full pi sessions: compaction (so compaction-time routing works per worker), session files (resumable), skills | Heavier; the API surface still needs checking for concurrent sessions in one process |
| C. `pi --mode json -p` subprocess (pi's `subagent` example) | Strong isolation; real parallelism; loads the user's extensions and skills | Loses the persistent cache between calls unless sessions are kept; process overhead |

**Decision (M1):** option **C** with persistent sessions (`--session-id`), because the researcher needs the user's pi-web-access extension and workers need the user's providers; see [Implementation status](#implementation-status). Originally considered: use **B** if concurrent sessions are stable,
otherwise **A** plus a small compaction routine of our own. Keep a `WorkerRunner`
interface so **C** can be added later as an isolation mode for untrusted projects.

---

## 7. The team: roles and model assignment

### 7.1 Default roles

"Tier" refers to the ladder the model picker already defines (`small` → `daily`
→ `frontier`). The router maps each tier to a concrete model, and you can pin any
role to a specific model with the picker.

| Role | What it does | Default tier and effort | Tools | Write scope | Why this tier |
|---|---|---|---|---|---|
| **Orchestrator** (the session itself) | Runs phases, talks to you, plans, dispatches, judges gates | frontier / high | all, plus factory tools | `.factory/**` | The judgement is the deliverable; never routed down |
| **Product analyst** | Runs the interview, keeps the assumption log, writes the spec and acceptance criteria | frontier / high | read, factory_ask, factory_brainstorm | `.factory/spec/**` | Interpreting what you mean is the highest-value judgement |
| **Researcher** | Prior art, library and framework comparisons, API docs, licence checks, sourced notes | daily / medium | read, web_fetch, web_search*, bash (read-only) | `.factory/research/**` | Mostly reading and summarising; escalates on contested questions |
| **Architect** | Stack choice (ADRs), module boundaries, API contracts, data model, conventions profile | frontier / high | read, grep, find, ls, write | `.factory/adr/**`, `.factory/contracts/**`, `docs/architecture/**` | Structural decisions are expensive to reverse |
| **Planner** | Breaks the spec into a ticket graph with dependencies, write scopes and acceptance tests per ticket | frontier / medium | read, grep, find, ls | `.factory/tickets/**` | Decomposition quality drives everything that follows |
| **Backend engineer** | Services, APIs, persistence, domain logic, unit and integration tests | daily / medium (escalates) | read, grep, find, ls, bash, edit, write | ticket scope, e.g. `src/server/**`, `tests/server/**` | Mostly well-specified work once the contracts exist |
| **Frontend engineer** | UI components, state, API client generated from contracts, component tests, accessibility | daily / medium (escalates) | same as backend, plus a browser/screenshot tool* | ticket scope, e.g. `web/**` | Same reasoning as backend; vision-capable model preferred |
| **DevOps engineer** | Project scaffold, build, lint and test tooling, Dockerfile, CI workflows, env templates, infrastructure-as-code files | small→daily / low | read, grep, find, ls, bash, edit, write | `.github/**`, `Dockerfile*`, `infra/**`, tool configs | Mostly templates; high leverage but low ambiguity |
| **QA engineer** | Writes acceptance and end-to-end tests from the spec *before* implementation; exploratory checks; bug reports | daily / medium | read, grep, find, ls, bash, edit, write | `tests/acceptance/**`, `tests/e2e/**` | Tests must be written independently of the code they check |
| **Reviewer** | Reviews each ticket diff for correctness, spec conformance, contract adherence, security and maintainability | frontier / high, from a different family than the author when one is available | read, grep, find, ls, bash (read-only) | none (writes review comments only) | A second model family catches errors the author's family tends to share |
| **Security reviewer** (optional) | Threat model, dependency audit, secrets scan, auth and input handling | frontier / high | read, grep, bash (read-only) | `.factory/security/**` | Security judgement; gated by a profile flag |
| **Tech writer** | README, architecture overview, API reference, runbook, CHANGELOG, `AGENTS.md` for future agents | small→daily / low | read, grep, find, ls, write | `docs/**`, `README.md`, `CHANGELOG.md`, `AGENTS.md` | Summarising and formatting; escalates only for architecture docs |
| **Sidekick** (per worker, optional) | Mechanical sub-steps for any worker: reading, grepping, running tests, gathering logs | small / low | read, grep, find, ls, bash | none | The existing Fusion sidekick, reused |

`*` Tools the factory does not have yet (see open questions Q4 and Q7).

### 7.2 Role definition format

This extends the frontmatter from pi's `subagent` example so that roles stay
plain Markdown you can edit:

```markdown
---
name: backend
description: Implements server-side tickets test-first against the API contract
tier: daily            # small | daily | frontier, or pin with model: provider/id
effort: medium
escalation: [daily, frontier]    # ladder used on repeated failure
tools: [read, grep, find, ls, bash, edit, write]
writeScope: ticket     # "ticket" = take from the ticket; or explicit globs
sidekick: true         # give this worker its own Fusion sidekick
reviewDiversity: true  # review by a different model family is required
maxTurns: 40
budgetUsd: 1.50        # per ticket attempt
---
You are the backend engineer on a small, disciplined software team...
(operating rules, test-first workflow, report format)
```

### 7.3 Model selection rules (the router)

The router works with any model pi can call. It reads model metadata (reasoning
support, context window, input types, price); it never matches provider names or
model IDs.

1. **Pinned model** in the role file or `factory.json`, if set, clamped to the
   model's supported effort.
2. Otherwise the **tier → model** mapping of the automatic team (§5.2).
   That mapping starts from `model-roles.json` when you have set roles with the
   picker, so the picker, Fusion and the factory agree.
3. **Diversity preference:** for `reviewer`, choose the highest-tier model from a
   different family than the author's. If only one family is available, use the
   same family with a stricter review prompt. It is a preference, never a
   requirement.
4. **Capability filters:** frontend prefers models that accept image input;
   research prefers the largest context window in its tier.
5. **Escalation** (§10.4) moves the worker up its `escalation` ladder. At a
   worker's compaction boundary, **routing** may move it down again, except for
   roles marked `judgement: true` (orchestrator, analyst, architect, reviewer),
   which are never downgraded.
6. **Failover:** on authentication, rate-limit or overload errors, the router
   retries on the next-best model in the same tier from any provider, records
   the switch in the ledger, and tells you once.

The model picker gains a `target: "factory-role"` mode and a *Factory* tab, so
you can assign a model to any role with the same two-panel UI and effort picker
used for Fusion today. It lists every provider pi knows about, including custom
and local ones.

---

## 8. Lifecycle: phases, gates and artifacts

The orchestrator is a state machine. Each phase has an owner role, inputs,
outputs written to `.factory/`, and an exit gate. Whether a gate stops for you
depends on the autonomy preset (§5.3). A gate that does not stop still runs
its automatic checks and posts a short summary to the transcript.

| # | Phase | Owner (helpers) | Output | Exit gate |
|---|---|---|---|---|
| 0 | **Intake** | Orchestrator | `.factory/brief.md` (your words, verbatim), project settings, autonomy level | Brief captured |
| 1 | **Discovery** | Product analyst (researcher, brainstorm fan-out) | `research/*.md`, `spec/assumptions.md`, interview log | Readiness checklist ≥ threshold (§9.3), or you say "go" |
| 2 | **Specification** | Product analyst | `spec/spec.md`: goals, personas, user stories, functional requirements with IDs, acceptance criteria in Given/When/Then, non-functional requirements, what is out of scope, glossary | **Spec approval** (every preset) |
| 3 | **Architecture** | Architect (researcher, security) | `adr/0001-*.md`…, `contracts/` (OpenAPI, GraphQL or typed interfaces, DB schema), `profile.json` (stack, conventions, gate commands), `docs/architecture/overview.md` | Automatic checks. You approve here only in `careful`; in `balanced` the architecture is part of the build-plan approval |
| 4 | **Planning** | Planner | `tickets/T-001.json`…, dependency graph, milestone slices, `traceability.json` (requirement → tickets) | **Build-plan approval** (`balanced`, `careful`): architecture summary, tickets and budget on one screen |
| 5 | **Walking skeleton** | DevOps (backend, frontend) | Repository scaffold, tooling, CI, a trivial end-to-end path deployable locally, every gate command passing on an empty app | All profile gates green on the skeleton |
| 6 | **Build loop** | Orchestrator dispatching workers | One merged branch per ticket; acceptance tests first (QA), then implementation, then review | Per ticket: gates green, reviewer approves, acceptance criteria covered (§10) |
| 7 | **Integration and verification** | QA (orchestrator) | Full end-to-end suite on the integration branch; exploratory test report; bug tickets looped back to phase 6 | All requirement IDs have passing tests; no open bugs above the chosen severity |
| 8 | **Documentation and release** | Tech writer (devops) | README, architecture docs, API reference, runbook, CHANGELOG, `AGENTS.md`, release notes, version tag | Release approval in `careful`; a release summary otherwise |
| 9 | **Retrospective and handoff** | Orchestrator | `.factory/retro.md`: cost per phase, escalations, what failed; suggested follow-up tickets | — |

**Change requests** at any point go through the orchestrator: update the spec →
diff the traceability matrix → mark affected tickets stale → re-plan only the
changed part. That keeps the process usable once the first release is out
(maintenance mode).

---

## 9. Discovery: brainstorming and requirement gathering with you

This is the part that decides whether the result is what you wanted. It gets
dedicated tools rather than free-form chat.

### 9.1 The interview loop

1. The analyst reads the brief and fills a **readiness checklist** (§9.3),
   marking each item *known*, *assumed* or *unknown*.
2. For the most important unknowns, it asks you **at most 4 questions per round**
   through `factory_ask`. Each question offers 2–4 concrete options, one marked
   *(recommended)* with its reasoning, plus a free-text answer. This uses the
   tabbed layout from pi's `questionnaire` example.
3. Every round also offers **Use your defaults**, which skips the remaining
   questions. Answers go to `spec/decisions.md`. Anything you skip becomes an
   **explicit assumption** in `spec/assumptions.md`, listed on the spec approval
   screen so you can override it.
4. Between rounds the analyst may call on the researcher (prior art, APIs,
   constraints) or run a brainstorm (§9.2). It brings back *options*, not
   decisions.
5. The loop ends when the readiness score reaches the threshold or you say
   "go". The number of rounds scales with the brief (§5.4). The analyst
   then drafts the spec, and you review it at the gate.

### 9.2 Multi-model brainstorm (`factory_brainstorm`)

This takes over from the removed Qwen extension, using the models you already
have configured in pi, called through `ctx.modelRegistry.streamSimple`:

- **Fan out** the question to 2–3 models, preferably from different families,
  each given a stance: *divergent* (widen the option space), *critical* (attack
  the assumptions), *pragmatic* (simplest thing that works).
- **Synthesise** on the orchestrator's model: merged option list, trade-off
  table, recommendation, open risks.
- Show you the result as a collapsible entry. Useful parts go into
  `research/brainstorm-*.md`.

### 9.3 Readiness checklist

The checklist is scored. Every item must be *known* or *assumed* before the spec
is drafted.

- Problem statement and success metrics
- Users and personas; roles and permissions
- Core user journeys (the top 3–5), with happy and failure paths
- Data: entities, ownership, retention, privacy class
- Integrations: external APIs, authentication providers, payments
- Non-functional requirements: expected scale, latency, availability, security
  level, accessibility, supported platforms
- Constraints: required language or stack, hosting target, budget, licence, deadline
- Out of scope for v1
- How you will accept it: what demo or check convinces you it is done

### 9.4 Spec quality rules (checked at the gate)

- Every functional requirement has an ID (`FR-012`) and at least one Given/When/Then
  acceptance criterion.
- Every non-functional requirement is measurable ("p95 < 300 ms at 50 rps", not
  "fast").
- Every requirement traces back to a question you answered, a stated assumption
  or the original brief.

---

## 10. The build loop

### 10.1 Per-ticket flow

```
ticket ready (dependencies merged)
  │
  ├─▶ QA worker: write/extend acceptance tests for the ticket's criteria (they fail: red)
  ├─▶ Workspace: git worktree  .factory/worktrees/T-042  on branch factory/T-042
  ├─▶ Builder (backend | frontend | devops): implement until the ticket's tests pass
  │      └─ may delegate mechanical steps to its own sidekick (Fusion pattern)
  ├─▶ Gate runner: build · typecheck · lint · unit · ticket acceptance tests · coverage delta
  │      └─ fail → structured failure back to the builder (bounded attempts)
  ├─▶ Reviewer (different model family): diff vs spec, contracts, conventions, security
  │      └─ changes requested → back to the builder with review comments
  ├─▶ Workspace: merge into factory/integration; re-run the full gate set there
  │      └─ conflict or red → orchestrator decides (rebase, re-ticket, or ask you)
  └─▶ Update ticket status, traceability (FR → test → commit), ledger; drop the worktree
```

### 10.2 Contract-first parallelism

- The architect's contracts (API schema, shared types, DB migrations) are built
  first as **foundation tickets**. Backend and frontend tickets then build against
  them at the same time. The frontend uses generated clients and mocks, so it
  does not wait for the backend.
- The scheduler runs a ticket only when (a) all its dependencies are merged, and
  (b) its `writeScope` does not overlap any running ticket's scope.
  `maxParallel` (default 3) caps how many run at once.

### 10.3 Definition of done (enforced by the harness, not claimed by the agent)

1. Every profile gate command exits 0 on the ticket branch *and* after merging
   to integration.
2. Each acceptance criterion linked to the ticket has at least one passing test.
3. The reviewer returns `approve` with no blocking findings.
4. No file outside the ticket's `writeScope` changed (checked on the diff).
5. Docs touched if public behaviour changed (the reviewer checks this).

### 10.4 Failure handling and escalation ladder

For each ticket, in order:

1. **Retry with feedback:** the builder gets the structured gate or review
   failure (at most 2 attempts at the current model).
2. **Escalate the model:** move up the role's `escalation` ladder, keeping the
   same worker context. Swapping the model on a persistent agent preserves the
   context, exactly as `setSidekickModel` does today.
3. **Orchestrator takeover:** the frontier orchestrator reads the failure and
   either fixes the ticket brief (the usual root cause), splits the ticket, or
   implements it itself.
4. **Ask you,** with a concise explanation of what is blocking and 2–3 options.

A **circuit breaker** stops the build loop and asks you when the phase budget is
80% spent, or when more than 30% of tickets have escalated. Both thresholds are
configurable.

---

## 11. How the factory keeps software maintainable

"Maintainable" is made concrete through the following mechanisms. Each one is
enforced by a gate or a reviewer checklist, not left to hope.

### 11.1 Profiles (stack knowledge as data)

`.factory/profile.json`, written by the architect from a template library in
this package (`profiles/node-ts-api`, `profiles/react-vite`,
`profiles/python-fastapi`, …):

```json
{
  "stack": { "language": "typescript", "runtime": "node22", "packageManager": "pnpm" },
  "layout": { "server": "apps/api/src", "web": "apps/web/src", "tests": "tests" },
  "gates": {
    "install":   "pnpm install --frozen-lockfile",
    "build":     "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint":      "pnpm -r lint",
    "unit":      "pnpm -r test -- --run",
    "e2e":       "pnpm e2e",
    "coverage":  { "command": "pnpm -r test -- --coverage", "minLines": 80, "noDecrease": true },
    "audit":     "pnpm audit --prod --audit-level high"
  },
  "conventions": "docs/conventions.md",
  "dependencyPolicy": { "requireAdrForNewRuntimeDep": true, "licenseAllow": ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"] }
}
```

### 11.2 Maintainability mechanisms

| Mechanism | How it is enforced |
|---|---|
| **ADRs** for every significant choice (stack, storage, auth, new runtime dependency) | Architecture gate; reviewer rejects new dependencies that have no ADR |
| **Contracts as the source of truth** (OpenAPI, schema) with generated clients and types | Gate: contract lint, plus a check that generated code is up to date |
| **Tests at every level**: unit per module, integration per service, acceptance per requirement, end-to-end per core journey | Coverage floor with no decrease allowed; traceability check that every FR has a test |
| **Conventions** doc (naming, layering, error handling, logging) written once by the architect | Linter config plus reviewer checklist |
| **Small modules with clear boundaries** | Reviewer flags files > ~400 lines and cross-layer imports; optional dependency-cruiser style rule in the profile |
| **CI from day one** (walking skeleton) | The same gate commands run locally and in CI |
| **Docs as code**: README, architecture overview, API reference, runbook, CHANGELOG | Docs phase gate, plus reviewer checks docs on behaviour changes |
| **`AGENTS.md`** describing the project for future AI or human contributors | Written in phase 8 and kept updated during maintenance |
| **Traceability**: FR → ticket → test → commit | `traceability.json` plus a final report; stale links fail the integration gate |
| **Conventional commits**, one ticket per branch, readable history | Workspace manager writes the commit messages; reviewer checks them |

---

## 12. Artifact store and data model

### 12.1 Layout in the target repository

```
.factory/
  factory.lock.json        # phase, autonomy, settings snapshot, current run id
  brief.md                 # your original request, verbatim
  spec/
    spec.md                # approved specification (FR/NFR IDs, Given/When/Then)
    assumptions.md
    decisions.md           # interview answers, with date and question
  research/*.md            # sourced notes, brainstorm syntheses
  adr/0001-stack.md …
  contracts/openapi.yaml, schema.sql, types.ts …
  profile.json             # stack, gates, conventions (§11.1)
  tickets/T-001.json …
  traceability.json
  reviews/T-001.md …       # reviewer output per ticket attempt
  ledger.jsonl             # append-only: usage, cost, routes, gate results
  retro.md
  roles/*.md               # optional project-level role overrides (trusted projects only)
  worktrees/               # git-ignored
```

Everything except `worktrees/` is committed, so the process history ships with
the code.

### 12.2 Core types (sketch)

```ts
type Phase =
  | "intake" | "discovery" | "spec" | "architecture" | "planning"
  | "skeleton" | "build" | "integration" | "release" | "retro" | "maintenance";

interface RoleDef {
  name: string;
  description: string;
  tier?: "small" | "daily" | "frontier";
  model?: string;                 // "provider/id" pin
  effort?: ThinkingLevel;
  escalation?: Array<"small" | "daily" | "frontier">;
  tools: string[];
  writeScope: "ticket" | string[];
  sidekick?: boolean;
  judgement?: boolean;            // never routed down
  reviewDiversity?: boolean;
  maxTurns?: number;
  budgetUsd?: number;
  systemPrompt: string;
}

interface Ticket {
  id: string;                     // "T-042"
  title: string;
  role: string;                   // "backend"
  dependsOn: string[];
  requirements: string[];         // ["FR-012", "NFR-003"]
  brief: string;                  // self-contained, Fusion-style
  acceptance: string[];           // Given/When/Then
  writeScope: string[];           // globs
  status: "todo" | "ready" | "in_progress" | "review" | "merged" | "blocked" | "stale";
  attempts: Array<{ model: string; outcome: "gate_fail" | "review_fail" | "ok" | "error"; costUsd: number; at: string }>;
  branch?: string;
  mergedCommit?: string;
}

interface GateResult {
  gate: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  summary: string;                // e.g. "3 failing tests: …"
  logExcerpt: string;             // bounded, like Fusion's trace excerpts
}
```

The session itself stores only pointers and UI state (`pi.appendEntry` for
`factory-phase`, `factory-gate`, `factory-ticket`). The files are the source of
truth, following pi's own guidance on state: data outside a single session
belongs in external storage.

---

## 13. User experience: commands, tools and UI

### 13.1 Commands

| Command | Action |
|---|---|
| `/factory new [idea]` | Start a new project: preflight, setup card (first time only), then the discovery interview |
| `/factory doctor` | Check git, toolchains, and every team model with a one-call tool-use probe; prints the fix for anything missing |
| `/factory demo` | Build a tiny sample project in a temporary folder on `auto`, to see the whole flow quickly and cheaply |
| `/factory team [cheap\|balanced\|best\|refresh]` | Show the team, or shift it with a preset; `refresh` re-detects logged-in models |
| `/factory` (or a shortcut) | Menu: status, board, roles and models, budgets, autonomy, resume |
| `/factory status` | Phase, gate state, budget used, next action |
| `/factory board` | Ticket board widget (todo / running / review / merged / blocked), with live worker progress |
| `/factory roles` | Assign models and effort per role through the model picker (`factory-role` target) |
| `/factory approve` / `/factory reject [note]` | Answer the current human gate |
| `/factory change "<request>"` | Change request: spec diff, stale tickets, re-plan |
| `/factory pause` / `/factory resume` | Stop dispatching / continue from `factory.lock.json` |
| `/factory trace <ticket\|role>` | Expandable trace of the latest agent run (reuses Fusion's renderer) |
| `/factory cost` | Ledger report: per phase, role, ticket and model, with savings against all-frontier |
| `/factory autonomy auto\|balanced\|careful` | Switch the autonomy preset at any time (§5.3) |

### 13.2 Tools the orchestrator gets (active only in factory mode)

| Tool | Purpose |
|---|---|
| `factory_ask` | Structured questions to you (options, recommended default, free text) |
| `factory_brainstorm` | Multi-model fan-out and synthesis (§9.2) |
| `factory_research` | Send a research brief to the researcher role |
| `factory_write_artifact` | Validated writes to `.factory/` (spec, ADR, ticket, profile) |
| `factory_dispatch` | Run a ticket or a role brief in the worker pool (non-blocking; returns a handle) |
| `factory_await` | Wait for dispatched work; returns results, gate results and review verdicts |
| `factory_gate` | Run named profile gates on a branch or worktree |
| `factory_request_approval` | Open a human gate with a summary, diff links and options |
| `sidekick` | Kept from Fusion for the orchestrator's own mechanical sub-steps |

### 13.3 UI surfaces

- **Footer status:** `🏭 build · 12/31 merged · 3 running · $4.10/$15 · saved 58%`
- **Widget:** a compact board with one line per running worker (role, model,
  ticket, last activity).
- **Entry renderers** for phase transitions, gate results, reviews, brainstorm
  syntheses and traces, collapsed by default as Fusion's traces are.
- **Non-TUI modes:** every interaction has a text fallback (`ctx.hasUI` checks),
  so the factory can run through pi's RPC mode with approvals forwarded.

---

## 14. Configuration

Configuration is **optional**. Every key has a default, and nothing needs editing
by hand. `~/.pi/agent/factory.json` is written only when you change a default
from the setup card or a command. `.factory/factory.lock.json` holds project
overrides. A fully customised file looks like this:

```json
{
  "autonomy": "balanced",
  "maxParallel": 3,
  "budgets": { "totalUsd": 25, "perPhaseUsd": { "discovery": 2, "architecture": 3, "build": 15 }, "breakerAt": 0.8 },
  "team": "auto",
  "roles": {
    "architect": { "model": "<provider>/<model-id>", "effort": "high" },
    "backend":   { "tier": "daily", "escalation": ["daily", "frontier"] },
    "reviewer":  { "tier": "frontier", "reviewDiversity": true }
  },
  "gates": { "requireReviewerApproval": true, "coverageNoDecrease": true },
  "research": { "webSearch": "none" },
  "trustProjectRoles": false
}
```

This reuses the existing `model-roles.json` (tiers) and `settings.json`
(per-model effort), so the picker, Fusion and the factory all agree on what
"small", "daily" and "frontier" mean. The model IDs above are examples only;
nothing is hard-coded (see bug B6).

---

## 15. Safety, cost and failure handling

- **Write-scope enforcement:** worker tools are created by the factory, so
  `edit`/`write` are wrapped to reject paths outside the ticket's globs. `bash`
  runs with the worktree as its working directory. After each attempt the diff is
  checked against the scope (§10.3 item 4).
- **Destructive commands:** a deny-list and a confirmation layer for `bash`
  (`rm -rf` outside the worktree, `git push`, package publishing, network deploy
  commands), modelled on pi's `permission-gate` and `protected-paths` examples.
  Optional container isolation (pi's `sandbox` example, or runner option C) for
  untrusted projects.
- **Secrets:** workers never see real secrets. DevOps writes `.env.example`, and a
  secret-scan gate runs before every merge.
- **Project-level roles** in `.factory/roles/` are prompts controlled by the
  repository, so they load only in trusted projects, following the subagent
  example's security model.
- **Budgets and breakers:** per-attempt, per-ticket, per-phase and total budgets;
  the breaker pauses at 80% and asks you.
- **Idempotency and recovery:** every phase transition and ticket status change
  is written to disk before side effects; `/factory resume` rebuilds the worker
  pool from `factory.lock.json` and tickets, and cleans up orphaned worktrees.
- **Cleanup:** `session_shutdown` disposes of workers and aborts in-flight runs,
  and is idempotent, per pi's extension contract.

---

## 16. Repository restructure

pi loads `extensions/*` entries. A directory with an `index.ts` counts as one
extension, which is how pi's `subagent` example is laid out. Shared code moves
into `src/`:

```
extensions/
  model-picker/index.ts      # thin: registration only
  fusion/index.ts            # thin: registration only
  factory/index.ts           # thin: registration only
src/
  shared/
    paths.ts                 # getAgentDir re-export, file paths
    json-store.ts            # atomic read/write, schema validation
    roles-config.ts          # the ONE loader for model-roles.json
    fusion-config.ts         # the ONE loader for fusion.json (fixes B7)
    models.ts                # ladder, clampEffort, family detection, cost helpers
    usage.ts                 # emptyUsage/addUsage/format helpers (from fusion.ts)
    trace.ts                 # buildTrace/renderTraceSteps (from fusion.ts)
  picker/                    # SplitModelPickerComponent, effort picker, role UI
  fusion/                    # FusionEngine, routing, prompts, wizard
  factory/
    orchestrator/            # phase machine, gates, prompts
    registry/                # role discovery + validation
    router/                  # tier resolution, diversity, escalation
    workers/                 # WorkerRunner interface + backends
    workspace/               # git worktrees, merge, checkpoints
    gates/                   # gate runner, result parsing
    store/                   # .factory artifact I/O + schemas
    discovery/               # interview, brainstorm, readiness scoring
    ui/                      # board widget, renderers, commands
  roles/*.md                 # default role definitions
  profiles/*/                # stack profile templates
test/                        # vitest, fake ExtensionAPI/ctx, fixture repos
```

Tooling to add: `tsconfig.json` (strict, `noEmit`), the peer packages as
`devDependencies` for typechecking, `vitest`, Biome or ESLint + Prettier, and a
GitHub Actions workflow running typecheck, lint and test on every push.

---

## 17. Implementation milestones

Each milestone is releasable on its own and has explicit exit criteria. Sizes are
rough (S = 1–2 sessions, M = 3–5, L = 6+).

### M0: hygiene and foundations (M)

- Fix B1–B9 (§2.3), with a regression test for each.
- Split into `extensions/*/index.ts` plus `src/` (§16), with no change in behaviour.
- Add a single config loader for `model-roles.json` and `fusion.json`; remove the
  side-effecting write from `loadRolesState` and the hard-coded outdated model IDs.
- Tooling and CI. Bump to `2.0.0` (Qwen removal is a breaking change for users of
  its tools and commands) and fix the README install tag.
- **Exit:** CI green; existing picker and Fusion behaviour unchanged in manual QA;
  more than 60% line coverage on `src/shared` and `src/fusion`.

### M1: quick-start slice, idea to working repo (L)

The first thing users get is the whole flow, end to end, at minimum depth. Later
milestones deepen each stage without changing how you start.

- Spike: choose runner A or B (§6.3) against a fixture repo (stability, cache
  hits, concurrency).
- **Onboarding:** preflight, automatic team from any logged-in models, setup
  card, `/factory doctor` (§5).
- Role registry (default roles only) and the provider-agnostic router: tiers,
  pins, effort clamping, failover.
- Minimal `.factory/` store and phase machine with the three autonomy presets.
- `factory_ask` interview with **Use your defaults**, then a spec and a simple
  ticket list.
- Sequential build in one worktree: builder, profile gates, single reviewer,
  README.
- **Exit:** on a clean machine with **any one** pi provider logged in,
  `/factory new "<small CLI tool>"` produces a tested, runnable repository with
  no hand-edited config and at most two approvals on `balanced`. The first
  question appears within about two minutes of install. The same run passes with
  two different providers and with a local OpenAI-compatible model.

### M2: resume, board and cost (M)

- `.factory/` schemas, atomic writes, `factory.lock.json`, append-only ledger.
- Pause and resume across pi restarts; resume prompt when pi opens a factory
  project.
- Board widget, footer status, entry renderers, `/factory status|cost|trace`,
  `/factory team` presets, the picker's `factory-role` target and Factory tab.
- **Exit:** a project survives a pi restart in every phase and resumes
  correctly; cost is reported per phase, role and model.

### M3: discovery depth (M)

- Readiness scoring, adaptive interview depth, assumptions and decisions logs.
- `factory_brainstorm` (multi-model fan-out and synthesis) and the researcher
  role with `web_fetch` (plus optional search; see Q4).
- Spec validator (§9.4).
- **Exit:** on three sample briefs, the interview takes at most 4 rounds (1 for
  small briefs) and produces a spec that passes the validator, which you rate
  usable without rewriting.

### M4: architecture, contracts and planning (M)

- Architect role with ADR template, profile templates (start with `node-ts-api`,
  `react-vite`, `python-fastapi`), contract generation.
- Planner: ticket graph, write scopes, requirement links, cycle detection, a
  check that every FR has at least one ticket; the one-screen build-plan
  approval.
- **Exit:** a ticket graph with no scope conflicts between parallel tickets, and
  a complete traceability matrix, for each sample brief.

### M5: parallel build loop and safety (L)

- Worktree per ticket, integration merges, conflict hand-off.
- Gate runner with structured failure parsing (test names, compiler errors).
- QA-first flow, cross-family review when available, escalation ladder, breakers.
- Write-scope enforcement, destructive-command gate, secret scan.
- Scheduler: parallelism aware of dependencies and write scopes.
- **Exit:** a sample brief (e.g. a TODO API with a web UI) builds end to end with
  every gate green, and each ticket's history is visible in the ledger.

### M6: integration, docs, release and demo (M)

- Full end-to-end run on integration; exploratory QA report; bug tickets loop back.
- Tech writer outputs; `AGENTS.md`; CHANGELOG; release summary or approval;
  retrospective.
- `/factory demo`.
- **Exit:** a repository a human can clone, read, run and extend using only its
  docs (checked by a fresh-session "new contributor" agent test).

### M7: evaluation, maintenance mode and hardening (M)

- Benchmark harness (§18), including onboarding metrics; cost and prompt tuning.
- `/factory change` on an existing factory project; **brownfield onboarding**
  (reverse-engineer spec, profile and ADRs from an existing repository).
- Optional runner C (subprocess or container isolation).

---

## 18. Testing and evaluating the factory

**Unit and integration tests for the package itself:**

- A fake `ExtensionAPI`/`ExtensionContext` (records registrations, UI calls and
  entries) for testing commands and events without a TUI.
- A scripted fake model (`streamFn` that replays fixtures) for deterministic
  tests of routing, escalation, the phase machine and the build loop.
- Fixture repositories for workspace and gate tests (real git, real commands).

**End-to-end evaluation suite** (run manually or nightly, real models):

- 6–10 reference briefs of increasing size: CLI tool, REST API, CRUD web app,
  webhook integration, background job worker, small full-stack SaaS slice.
- **Onboarding metrics:** time from install to the first question, number of
  screens before the build starts, hand-edited files (target: zero), and a
  first-run success rate across a provider matrix (a single API provider, a
  subscription login, a custom or local model, and mixed providers).
- **Metrics per run:** acceptance criteria passing, gates green, reviewer
  blocking findings, human interventions, wall-clock time, cost, cost against an
  all-frontier baseline, escalation rate, and a maintainability score (lint
  warnings, module size distribution, coverage, doc completeness, the
  "new contributor" test).
- Store results in `bench/results/*.json` and compare them across factory
  versions, so prompt and routing changes are judged on evidence, as the Fusion
  post judges its own design.

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| Specs look complete but miss what you actually meant | Structured interview, explicit assumptions, spec gate, change-request flow |
| Cheap models produce plausible but wrong code | Tests written first by a separate QA worker; deterministic gates; cross-family review; escalation |
| Parallel workers conflict | Disjoint write scopes, contracts first, integration re-gate after every merge |
| Costs run away | Budgets at four levels, breaker, ledger, routing down for mechanical roles |
| Prompt caches expire between delegations (noted in the Fusion README) | Keep worker prompts and tool declarations stable; batch work per worker; measure cache hit rate in M1 |
| Upstream pi API changes | Peer dependencies typechecked in CI; thin extension entry points; the runner interface isolates SDK use |
| Prompt injection from researched web content or repository files | Research output is data and lands in `.factory/research`; the orchestrator never runs instructions found in it; project roles only load for trusted projects |
| The automatic team is a poor fit for your models | Shown on the setup card with one key to change any role; `/factory team` presets; `/factory doctor` probes each model's tool use before work starts |
| Weak or local models cannot handle judgement roles | Judgement roles are never assigned below the `daily` tier when a stronger model exists; with a single weak model the card warns and suggests `careful` |
| Scope grows too large for one package | Milestones ship on their own; the factory could be split into its own package after M2 (Q8) |

---

## 20. Open questions

**Answered**

- **Q1, autonomy:** configurable, optimised for ease of use and quick setup.
  Three presets, default `balanced` (§5.3).
- **Q3, providers:** every provider and model pi supports, with no limits and in
  any mix. The team is derived automatically (§5.2), and cross-family
  review is used when available, never required.

- **Q2, Q5, Q6, Q9 — stacks, existing repos, deployment, budget:** flexible,
  asked in the quick setup with prefilled defaults (§5.1): stack = architect's
  choice or the detected stack; project = new or existing (detected); deploy =
  local, config only, or a detected logged-in CLI (always confirmed); budget =
  estimated from the team's prices.
- **Q4, web research:** through the pi-web-access extension (`web_search`,
  `fetch_content`), offered for install during setup when missing.

**Still open.** Each question has the default the plan assumes. Answering any of
them changes the plan in the section noted.

| # | Question | Default assumption | Affects |
|---|---|---|---|
| Q7 | Should the frontend role get browser tooling (screenshots, visual checks, Playwright)? | Yes, via Playwright end-to-end tests plus screenshots given to a vision-capable reviewer | §7.1, M5 |
| Q8 | Keep the factory in this package (named `pi-model-picker`, now in the `FaceMe/pi-dev-team` repository), or split it into its own package (e.g. `pi-factory`) that depends on shared code published from here? | Build it here under `extensions/factory` through M2, then decide | §16 |
| Q10 | Should factory runs be usable headless (CI, RPC) from the start? | Design for it (`ctx.hasUI` fallbacks) but test interactively first | §13.3 |
