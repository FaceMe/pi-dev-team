# pi dev team

A software factory, a model picker and a hybrid model harness for the
[pi coding agent](https://github.com/badlogic/pi-mono):

1. **Software factory** (`/factory`) — a team of role-specialised agents
   (analyst, researcher, architect, planner, backend, frontend, devops,
   reviewer, docs) that interviews you, writes a spec, designs, builds
   test-first, reviews, documents and merges a maintainable project. Works with
   any model pi supports.
2. **Model picker, roles & reasoning effort** — a two-panel picker, a role manager
   (`daily` / `small` / `frontier`) and a reasoning-effort controller.
3. **Fusion** — a hybrid model harness: a frontier main agent
   plus a persistent cheap "sidekick" agent, with dynamic mid-session routing.

```bash
pi install git:github.com/FaceMe/pi-dev-team
```

All extensions ship in the same package and load independently.

## Software factory — quick start

```bash
mkdir habit-tracker && cd habit-tracker && pi
```

```text
/factory new a habit tracker with a web UI and a REST API
```

1. **Quick setup** — one screen of prefilled answers. Press Enter to accept them
   all, or open any line to change it:

   | Question | Prefilled default |
   |---|---|
   | Team | Built automatically from the models you are logged in to (any provider, including custom and local models); presets `balanced` / `cheap` / `best`, or pin any role to a model with the picker |
   | Autonomy | `balanced` — you approve the spec and one build plan (`auto`: spec only; `careful`: every phase and ticket) |
   | Project | New project, or "add to the existing project" when the folder already has code |
   | Stack | Let the architect choose (or keep the detected stack of an existing project) |
   | Web research | [pi-web-access](https://www.npmjs.com/package/pi-web-access) (`web_search`, `fetch_content`); offered for install if missing |
   | Deployment | Run locally; or generate deploy config; or deploy with a detected, logged-in CLI (always asks first) |
   | Budget | Estimated from your team's prices and the size of the idea; pauses at 80% |

   Your answers are remembered: team, autonomy and research for every project,
   the rest per folder.
2. **Interview** — at most 4 questions per round, each with a recommended
   answer and a "use your defaults" option. Small ideas get one round.
3. **Spec → architecture → plan** — `.factory/spec/spec.md` (FR/NFR IDs with
   Given/When/Then), an ADR, a stack profile with gate commands, and a ticket
   list. You approve per the autonomy preset.
4. **Build** — a walking skeleton first, then each ticket test-first in a git
   worktree (`factory/<run>` branch). Gates (install/build/typecheck/lint/test)
   are run by the factory, not claimed by the agent; a reviewer from a
   different model family approves each ticket. Failures retry with feedback,
   then escalate to a stronger model, then ask you.
5. **Docs and release** — README, architecture notes, `AGENTS.md`, CHANGELOG;
   the branch is merged into yours when the gates pass; `.factory/report.md`
   lists tickets and cost by role.

| Command | Action |
|---|---|
| `/factory new [idea]` | Quick setup, then run the whole flow |
| `/factory status` · `/factory cost` | Where the run is; spend by role and model |
| `/factory pause` · `/factory resume` | Pause after the current step; continue (also after restarting pi) |
| `/factory doctor [probe]` | Check git, pi, models, team, pi-web-access, toolchains and deploy CLIs, with fixes; `probe` sends one tool call to each team model |
| `/factory team [balanced\|cheap\|best]` | Show or change the team |
| `/factory autonomy auto\|balanced\|careful` | Switch at any time, even mid-run |
| `/factory settings` | Change the quick-setup answers for this folder |
| `/factory run <role> <brief>` | Run one role once, read-only (try a model, ask the architect) |
| `/factory demo` | Build a tiny to-do CLI in a temp folder on `auto` |

How it works:

- **Workers are real `pi` processes** (`pi --mode json`) with a persistent
  session per role and ticket, so they reuse context and prompt cache, load
  your providers and extensions (pi-web-access for research), and a crash
  never takes down your session.
- **Guard rails inside every worker**: `edit`/`write` outside the ticket's
  write scope are blocked, and so are `git push`/commit, `sudo`, publishing,
  piped remote scripts, and deploy commands (unless you approved a deploy).
  The factory also reverts any out-of-scope change before running gates.
- **Headless**: without a UI (print/JSON/RPC mode) `/factory new` accepts the
  prefilled answers and runs to completion.
- **Roles are Markdown** — override any role (tier, effort, tools, prompt) in
  `~/.pi/agent/factory/roles/<role>.md`.

Project state lives in `.factory/` (spec, ADRs, profile, tickets, reviews,
ledger, report; worker sessions and the worktree are git-ignored). See
[docs/software-factory-plan.md](docs/software-factory-plan.md) for the design
and roadmap.

## Model picker

### Two-panel model picker

Open with `/models`, `/mp`, `/picker`, `/model-picker` or `Ctrl+Shift+M`.

- **Left panel** — providers with auth indicators and model counts.
- **Right panel** — models with context window, thinking/reasoning badges with effective effort (e.g. `🧠 high`), and vision indicators.
- **Spec card** — shows active effort, token limits, cost, and exact supported reasoning levels.

| Key | Action |
|---|---|
| `←` / `→` | Switch focus between provider and model panels |
| `↑` / `↓` | Navigate items in the focused panel |
| `Enter` | Switch to the highlighted model (applies its configured reasoning effort) |
| `e` | Open interactive **Reasoning Effort Picker** for highlighted model |
| `Tab` | Toggle "configured providers only" / "all providers" |
| `/` | Search / filter models in real time |
| `Esc` | Clear search, or exit picker |

#### In-Picker Reasoning Effort Picker

Pressing `e` on any reasoning model opens the dedicated effort picker in the right panel, displaying **only** the effort levels actually supported by that specific model:

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate between supported effort levels |
| `e` | Quick-cycle to the next supported level |
| `0`–`9` | Jump directly to an effort tier by index |
| `Enter` | Apply selected effort to the model (persisted in `settings.json`) |
| `Space` | Apply selected effort **and** immediately switch to that model |
| `Esc` / `←` | Cancel and return to the model list |

### Roles

Assign models to three roles and switch between them instantly:

- **daily** — the workhorse model, also the startup default
- **small** — a fast, lightweight model for tiny tasks
- **frontier** — an advanced reasoning model for complex tasks

Inside the picker:

| Key | Action |
|---|---|
| `d` | Assign highlighted model as **daily** (clamped to model's effort support) |
| `s` | Assign highlighted model as **small** (clamped to model's effort support) |
| `f` | Assign highlighted model as **frontier** (clamped to model's effort support) |
| `m` | Assign highlighted model as **Fusion Main** (frontier) agent |
| `k` | Assign highlighted model as **Fusion Sidekick** (cheap) agent |
| `e` | Open Reasoning Effort Picker for highlighted model |
| `1` / `2` / `3` | Quick-switch to daily / small / frontier |
| `4` / `5` | Quick-switch to Fusion Main / Fusion Sidekick |

Slash commands:

| Command | Action |
|---|---|
| `/role [daily\|small\|frontier]` | Switch role, or open the interactive role menu |
| `/daily`, `/small`, `/tiny`, `/frontier` | Direct role activation |
| `/default [model]` | Set the startup default model in `settings.json` |

### Fusion Model Selection

The Model Picker directly powers model selection for Fusion — no separate or flat selector needed:

- In `/fusion` menu: choosing **main agent** or **sidekick** opens the full two-panel Model Picker with capability badges, token limits, search, and the interactive Reasoning Effort Picker (`e`).
- `/fusion main` and `/fusion sidekick` directly launch the Model Picker to configure the respective Fusion slot.
- Live `[🔮 Fusion Main]` and `[⚡ Fusion Sidekick]` badges and a dedicated Fusion Ribbon are displayed right inside the picker.

### Reasoning effort

Effort levels are validated and clamped against the model's actual capabilities (via `@earendil-works/pi-ai`'s `getSupportedThinkingLevels` and `clampThinkingLevel`). Unsupported levels (e.g. `xhigh`/`max` on models that only support up to `high`, or `off` on models where thinking is mandatory) are prevented or clamped gracefully.

| Command | Action |
|---|---|
| `/effort` (no args) | Interactive prompt displaying **only the effort levels supported by the active model** |
| `/effort <level>` | Set reasoning effort directly for the active model (clamped to capabilities) |
| `/effort <model>` | Interactive prompt to configure effort for a specific model |
| `/effort <model> <level>` | Set and persist default reasoning effort for any model |
| `/think` | Alias of `/effort` |

- **Tier aliases**: `min`, `med`, `mid`, `hi`, `max`, `0`–`6` are supported.
- **Tab completions**: dynamically adapt to the active model's supported reasoning tiers.
- The alias is `/think`, not `/thinking`: `/thinking` is already a pi built-in, and
  re-registering it would only shadow that command and drop it from autocomplete.

### Exit

`/exit` shuts down pi gracefully. (`/quit` is pi's own built-in command, so it is not
registered here — use either one.)

## Fusion

A hybrid two-agent harness. Instead of
picking one model for a whole session, a frontier **main** agent (this pi
session) delegates well-scoped work to a cheaper **sidekick** agent that keeps
its own transcript and its own tools — so the expensive prefix is not re-sent on
every call the way a stateless "ask another model" tool would.

Enable with `/fusion on` (on by default once configured). Open the menu with
`/fusion` or `Ctrl+Shift+D`.

### How it works

0. **Delegation is enforced, not just suggested.** Telling a frontier model to
   "delegate by default" is not enough — with bash/edit/write at hand it does
   the work itself. `delegation.mode` makes it structural:

   | Mode | Main agent | What goes to the sidekick |
   |---|---|---|
   | `balanced` (default) | reads, edits, runs commands | tests, builds, linters, type checks and installs (direct calls are redirected with a ready-made `sidekick(...)` call); any direct command output over 8k chars is condensed by the sidekick's model (full log kept on disk); a nudge after 6 direct calls in a row |
   | `strict` | read-only (`read`, `grep`, `find`, `ls`) + sidekick | everything that executes or edits — Devin's "minimal direct action" |
   | `advisory` | everything | only what the model chooses (the old behaviour) |

   Switch with `/fusion mode strict|balanced|advisory` or in the `/fusion` menu.
   If delegations fail twice in a row, the policy relaxes so the main agent is
   never stuck.

1. **Sidekick delegation.** The main agent gets a `sidekick` tool. A prompt
   section tells it to take minimal direct action, delegate mechanical work
   (targeted reads/greps, mechanical edits, running tests, collecting verbose
   output) and keep the significant decisions — the plan, the interpretation of
   ambiguity, the final review. Every brief must be self-contained, because the
   sidekick cannot see the conversation.
2. **Dynamic mid-session routing.** A lightweight classifier scores the running
   task at each compaction boundary and moves the main model and/or the sidekick
   model up or down a capability ladder (`small` → `daily` → `frontier`, from
   `model-roles.json`). Compaction invalidates the prompt cache anyway, so
   switching there is free. The sidekick can be upgraded in place without going
   back to the main model.
3. **Escalation.** Two consecutive failed delegations escalate the sidekick one
   tier automatically.

### Usage flow

A typical first-run session:

1. **`/fusion`** (or `Ctrl+Shift+D`) — open the interactive menu.
2. **`/fusion main`** — pick the frontier model for the main agent via the
   Model Picker (or `/fusion main provider/model`). This also switches the
   session to it immediately.
3. **`/fusion sidekick`** — pick the cheap model (default: your `small` role)
   and, in the menu, the sidekick's tools (`read, grep, find, ls, bash` by
   default; add `edit`/`write` if it should make changes).
4. **`/fusion on`** — enable the harness. The session model (footer,
   bottom-right) syncs to the fusion main slot, the `sidekick` tool activates,
   and the main agent's system prompt gains the delegation discipline.
5. **Use pi normally.** The main agent plans, resolves ambiguity and verifies;
   it delegates mechanical work (reads, greps, tests, builds, mechanical edits)
   to the sidekick via the `sidekick` tool. Each delegation streams live
   progress and reports model · turns · tokens · cost. The delegation's full
   log — the sidekick's thinking, tool calls and their outputs — stays
   collapsed: expand the tool row to see it, or run `/fusion trace`.
6. **Routing (optional).** In `/fusion` → routing, pick `llm` or `heuristic`
   mode and auto-apply vs suggest-only. At each `/compact`, the classifier may
   move the main and/or sidekick model up or down the `small → daily →
   frontier` ladder (auto-applied, or suggested for `/fusion route` to apply).
7. **`/fusion stats`** — delegation counts, sidekick cost vs estimated
   main-only cost, savings %, and every routing decision.
8. **`/fusion reset`** — clear the sidekick's context and session stats.
9. **`/fusion off`** — disable the harness and restore the model that was
   active before you enabled Fusion.

What you'll see in the footer while Fusion is on:

- **Bottom-right (model display):** always the *live* main model. It syncs to
  the main slot on `/fusion on`, and again if routing auto-applies a main-slot
  change at a compaction boundary. `/fusion off` restores your pre-Fusion model
  — unless you explicitly picked a model meanwhile (`/model`, `Ctrl+P`), in
  which case your pick wins.
- **Extension status line:** `⚛ fusion <sidekick-model> · N% saved ($x)` — the
  sidekick lives here (it is an in-process agent, not the session model).
- **Widget above the footer:** `main ... · sidekick ...`, delegation, failure
  and cost counters, and the delegation mode with the share of work that went
  through the sidekick (redirected calls, condensed outputs, background tasks).

Notes on the sync: `/fusion on` is idempotent — run it again after startup or
`pi -m <model>` to re-sync the session model with the main slot. Fusion never
overrides your model at session start, so a CLI/model-picker choice always
survives until you explicitly enable Fusion.

### Commands

| Command | Action |
|---|---|
| `/fusion` | Interactive menu: main/sidekick models, sidekick tools, routing, state, stats |
| `/fusion main [model]` | Select or set the main (frontier) agent model via the Model Picker |
| `/fusion sidekick [model]` | Select or set the sidekick (cheap) agent model via the Model Picker |
| `/fusion mode [strict\|balanced\|advisory]` | Show or set how strongly the main agent is made to delegate |
| `/fusion on` | Enable Fusion: activate the sidekick tool + prompt section and switch the session model to the fusion main slot (idempotent — re-run to re-sync) |
| `/fusion off` | Disable Fusion: remove the tool and prompt section and restore your pre-Fusion model (unless you picked a model yourself meanwhile) |
| `/fusion stats` | Session + lifetime cost/savings report in the transcript |
| `/fusion trace` | Dump the latest delegation's log (thinking, tool calls, outputs) into the transcript as an expandable entry |
| `/fusion route` | Classify the current task now and apply the routing decision |
| `/fusion reset` | Drop the sidekick's context and reset session stats |
| `Ctrl+Shift+D` | Open the Fusion menu |

The menu shortcut is `Ctrl+Shift+D` (`ctrl+shift+f` is pi's built-in alt-screen
search, so it is left alone). Rebind it with `"shortcut"` in
`~/.pi/agent/fusion.json` — e.g. `"shortcut": "ctrl+shift+j"` — then run
`/reload`.

### Sidekick tool

| Parameter | Description |
|---|---|
| `task` | The subtask, written as a standalone brief with exact paths and acceptance criteria |
| `context` | Extra context the sidekick needs but cannot discover itself |
| `files` | Files the sidekick should focus on |
| `expect` | `summary` \| `diff` \| `evidence` \| `raw` — shape of the answer |
| `background` | `true` runs the delegation in parallel with the main agent; the result is delivered into the conversation when it finishes |

`sidekick_wait` collects background results (all outstanding, or by id). A run
never settles with background work outstanding: the main agent gets the
results for one more turn to review them.

The sidekick itself works on one delegation at a time (it has one persistent
context); background delegations queue behind each other while the main agent
keeps working.
The sidekick's tools default to `read, grep, find, ls, bash`; add `edit`/`write`
in `/fusion → sidekick tools` if you want it to make changes.

### Sidekick trace (thinking + output logs)

Every delegation records a bounded, structured trace of what the sidekick did:
its thinking blocks (including redacted ones, marked as such), every tool call
with a described command/target, and each tool's output as a line- and
character-capped excerpt. Failures and aborts appear as error steps.

It is hidden by default — three ways to see it on demand:

- **Expand the tool row** (pi's expand key, shown as a hint under the result):
  the collapsed row keeps the compact preview; expanding appends the full trace
  under a divider. This also works on old entries after a reload (traces are
  stored in the session).
- **`/fusion trace`** — appends the latest delegation's trace to the transcript
  as an expandable `sidekick trace` entry. Also in `/fusion` → *last
  delegation trace*.
- **Failed delegations** embed a compact tail of the last steps in the error
  itself, so the failure context is visible without any extra step.

### Cost accounting

Each delegation is priced twice: once at the sidekick's real rates, and once at
the main model's rates to estimate what the work would have cost without
Fusion. The footer shows the session savings ratio and the lifetime saving, and
`/fusion stats` prints the full breakdown plus every routing decision.

Routing changes are session-scoped (like pi's own `/model`): the sidekick model
chosen by routing is recorded in the session and restored on resume, but
`fusion.json` keeps your configured defaults.

### Configuration

`~/.pi/agent/fusion.json` is created on first use, seeded from the model-picker
roles (`frontier` → main, `small` → sidekick):

```json
{
  "enabled": true,
  "main": { "provider": "openai-codex", "modelId": "gpt-6-astra", "effort": "high" },
  "sidekick": { "provider": "antigravity", "modelId": "gemini-3.8-flash", "effort": "low" },
  "sidekickTools": ["read", "grep", "find", "ls", "bash"],
  "routing": {
    "enabled": true,
    "mode": "llm",
    "autoApply": true,
    "onCompact": true,
    "escalateOnFailure": true
  },
  "limits": { "maxTurns": 12, "maxMessages": 40 },
  "delegation": { "mode": "balanced", "nudgeAfter": 6, "compressOutputChars": 8000 },
  "sidekickPrompt": "optional override for the sidekick system prompt"
}
```

`routing.mode` selects the classifier: `llm` (a cheap model scores the task and
falls back to the heuristic on any failure), `heuristic` (keyword/regex signals
only, no extra model call), or `off`.

### Notes and limits

- The sidekick keeps a persistent transcript, but provider prompt caches expire
  (commonly after ~5 minutes). Delegations spaced further apart than that pay a
  cold prefix; the system prompt and tool declarations stay stable so the prefix
  is still cacheable.
- The sidekick transcript is a sliding window (`limits.maxMessages`) cut on a
  user-message boundary, so old delegated work is dropped rather than overflowing
  the sidekick's context.
- `sidekickTools` with `edit`/`write` gives a cheaper model write access to your
  repo; those tools share pi's per-file mutation queue with the built-ins.
- Automatic main-model routing is skipped in any session where you picked the
  model yourself (`/model`, `Ctrl+P`, `--model`).

## State

- `~/.pi/agent/model-roles.json` — role assignments and startup defaults.
- `~/.pi/agent/settings.json` — `defaultProvider`, `defaultModel`, and `modelThinkingLevels` (per-model reasoning efforts natively recognized by Pi core on model switch).
- `~/.pi/agent/fusion.json` — Fusion configuration (main/sidekick slots, routing, limits).
- `~/.pi/agent/fusion-stats.json` — Fusion lifetime cost/savings ledger.
- `~/.pi/agent/factory.json` — factory answers remembered across projects (team preset, pins, autonomy, research).
- `~/.pi/agent/factory/roles/*.md` — optional role overrides.
- `<project>/.factory/` — a factory run's state, artifacts and ledger.

## Development

Each extension is a thin entry point under `extensions/<name>/index.ts`; the
code lives in `src/`:

- `src/shared/` — config files, model helpers, capability tiers, traces, usage
- `src/picker/` — the two-panel model picker, roles and effort controller
- `src/fusion/` — the Fusion engine (`engine.ts`) and its commands/UI (`extension.ts`)
- `src/factory/` — the software factory: `pipeline.ts` (phase machine), `runner.ts`
  (pi worker subprocesses), `guard.ts`, `team.ts`, `setup.ts`, `gates.ts`,
  `git.ts`, `prompts.ts`, and the default roles in `roles/*.md`

Pi core packages are peer dependencies supplied by pi itself. For development:

```bash
npm install        # dev dependencies: pi packages for types, vitest, typescript
npm run check      # typecheck + tests (includes real pi workers against a mock model)
pi -e ./extensions/model-picker/index.ts -e ./extensions/fusion/index.ts -e ./extensions/factory/index.ts
```

## License

[MIT](LICENSE)
