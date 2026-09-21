# pi-model-picker

Model tooling for the [pi coding agent](https://github.com/badlogic/pi-mono):

1. **Model picker, roles & reasoning effort** — a two-panel picker, a role manager
   (`daily` / `small` / `frontier`) and a reasoning-effort controller.
2. **Fusion** — a hybrid model harness: a frontier main agent
   plus a persistent cheap "sidekick" agent, with dynamic mid-session routing.

```bash
pi install git:github.com/rsudharshan/pi-model-picker@v1.2.0
```

Both extensions ship in the same package and load independently.

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
| `e` | Open Reasoning Effort Picker for highlighted model |
| `1` / `2` / `3` | Quick-switch to daily / small / frontier |

Slash commands:

| Command | Action |
|---|---|
| `/role [daily\|small\|frontier]` | Switch role, or open the interactive role menu |
| `/daily`, `/small`, `/tiny`, `/frontier` | Direct role activation |
| `/default [model]` | Set the startup default model in `settings.json` |

### Reasoning effort

Effort levels are validated and clamped against the model's actual capabilities (via `@earendil-works/pi-ai`'s `getSupportedThinkingLevels` and `clampThinkingLevel`). Unsupported levels (e.g. `xhigh`/`max` on models that only support up to `high`, or `off` on models where thinking is mandatory) are prevented or clamped gracefully.

| Command | Action |
|---|---|
| `/effort` (no args) | Interactive prompt displaying **only the effort levels supported by the active model** |
| `/effort <level>` | Set reasoning effort directly for the active model (clamped to capabilities) |
| `/effort <model>` | Interactive prompt to configure effort for a specific model |
| `/effort <model> <level>` | Set and persist default reasoning effort for any model |
| `/thinking` | Alias of `/effort` |

- **Tier aliases**: `min`, `med`, `mid`, `hi`, `max`, `0`–`6` are supported.
- **Tab completions**: dynamically adapt to the active model's supported reasoning tiers.

### Exit

`/exit` and `/quit` shut down pi gracefully.

## Fusion

A hybrid two-agent harness. Instead of
picking one model for a whole session, a frontier **main** agent (this pi
session) delegates well-scoped work to a cheaper **sidekick** agent that keeps
its own transcript and its own tools — so the expensive prefix is not re-sent on
every call the way a stateless "ask another model" tool would.

Enable with `/fusion` (on by default once configured). Open the menu with
`/fusion` or `Ctrl+Shift+F`.

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

### Commands

| Command | Action |
|---|---|
| `/fusion` | Interactive menu: main/sidekick models, sidekick tools, routing, state, stats |
| `/fusion on` / `/fusion off` | Enable or disable Fusion (removes the tool and the prompt section) |
| `/fusion stats` | Session + lifetime cost/savings report in the transcript |
| `/fusion route` | Classify the current task now and apply the routing decision |
| `/fusion reset` | Drop the sidekick's context and reset session stats |
| `Ctrl+Shift+F` | Open the Fusion menu |

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

## State

- `~/.pi/agent/model-roles.json` — role assignments and startup defaults.
- `~/.pi/agent/settings.json` — `defaultProvider`, `defaultModel`, and `modelThinkingLevels` (per-model reasoning efforts natively recognized by Pi core on model switch).
- `~/.pi/agent/fusion.json` — Fusion configuration (main/sidekick slots, routing, limits).
- `~/.pi/agent/fusion-stats.json` — Fusion lifetime cost/savings ledger.

## Development

The package is one file per extension:
[`extensions/model-picker.ts`](extensions/model-picker.ts) and
[`extensions/fusion.ts`](extensions/fusion.ts).
Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`) are peer dependencies
supplied by pi itself — no `npm install` needed. Try it without installing:

```bash
pi -e /path/to/pi-model-picker
```

## License

[MIT](LICENSE)
