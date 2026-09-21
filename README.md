# pi-model-picker

Model tooling for the [pi coding agent](https://github.com/badlogic/pi-mono):

1. **Model picker, roles & reasoning effort** — a two-panel picker, a role manager
   (`daily` / `small` / `frontier`) and a reasoning-effort controller.
2. **Fusion** — a hybrid model harness: a frontier main agent
   plus a persistent cheap "sidekick" agent, with dynamic mid-session routing.
3. **Qwen** — brainstorming and web research with Qwen models (`qwen3.8-max`
   and friends) on chat.qwen.ai, through your logged-in Chrome session.

```bash
pi install git:github.com/rsudharshan/pi-model-picker@v1.4.0
```

All extensions ship in the same package and load independently.

## Features

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
- **Widget above the footer:** `main ... · sidekick ...` plus delegation,
  failure and cost counters.

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

Delegations are serialized, so parallel tool calls from the main agent queue up.
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

## Qwen (chat.qwen.ai)

Brainstorm and research with Qwen's chat models — including the flagship
**Qwen3.8-Max** — from inside pi. Access goes through your logged-in Chrome
session (pi browser harness → CDP → the real chat.qwen.ai page), which is the
only reliable path: Alibaba's risk engine blocks direct API calls from Node
(`RGV587_ERROR::SM`). Your browser session is the authentication — no tokens to
manage.

### Setup

1. Connect the browser harness: `/browser-setup`.
2. Log in to chat.qwen.ai once in that Chrome, then `/qwen-auth` to verify.

### Tools for the agent

| Tool | Purpose |
|---|---|
| `qwen_brainstorm` | Ideation, design review, stress-tests. Modes: `general`, `divergent`, `critical`, `comparative`, `deep`, `synthesis`. Params: `model`, `search`, `thinking`, `new_chat`. Multi-turn within a thread. |
| `qwen_research` | Web-search research with citations; `deep: true` runs Qwen Deep Research (slow, thorough). |

### Commands

| Command | Action |
|---|---|
| `/brainstorm [topic]` | Quick brainstorm (general mode); asks to inject the result. |
| `/qwen-research <query>` | Web-search research with sources. |
| `/qwen status` | Daemon, login, model list, timeouts. |
| `/qwen ask [topic]` / `/qwen research [query]` | Interactive ask/research. |
| `/qwen model [id]` | List or switch models; saves the default. |
| `/qwen thinking <auto\|thinking\|fast>` | Default thinking chip. |
| `/qwen new` | Fresh thread on chat.qwen.ai. |
| `/qwen cleanup` | Delete chats created during testing. |
| `/qwen-auth` | Open/verify the chat.qwen.ai login. |

### Configuration

`~/.pi/agent/qwen.json`:

```json
{
  "defaultModel": "qwen3.8-max",
  "defaultThinking": "Auto",
  "timeoutSec": 240,
  "researchTimeoutSec": 420,
  "deepResearchTimeoutSec": 900
}
```

### How it works

The extension talks CDP through the pi browser daemon, attaches to the
chat.qwen.ai tab, and drives the real page: switches the model, toggles Web
search / Deep Research, sends prompts with React-safe input events, and detects
completion by tee-ing the page's own SSE stream (clone-based fetch hook) plus
the composer's Stop button. Thinking summaries, search phases and citations are
extracted from the stream and DOM without touching the app's own connection.

## State

- `~/.pi/agent/model-roles.json` — role assignments and startup defaults.
- `~/.pi/agent/settings.json` — `defaultProvider`, `defaultModel`, and `modelThinkingLevels` (per-model reasoning efforts natively recognized by Pi core on model switch).
- `~/.pi/agent/fusion.json` — Fusion configuration (main/sidekick slots, routing, limits).
- `~/.pi/agent/fusion-stats.json` — Fusion lifetime cost/savings ledger.
- `~/.pi/agent/qwen.json` — Qwen extension defaults (model, thinking, timeouts).

## Development

The package is one file per extension:
[`extensions/model-picker.ts`](extensions/model-picker.ts),
[`extensions/fusion.ts`](extensions/fusion.ts) and
[`extensions/qwen.ts`](extensions/qwen.ts).
Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) are peer dependencies
supplied by pi itself — no `npm install` needed. Try it without installing:

```bash
pi -e /path/to/pi-model-picker
```

## License

[MIT](LICENSE)
