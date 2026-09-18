# pi-model-picker

Two-panel model picker, role manager and reasoning-effort controller for the
[pi coding agent](https://github.com/badlogic/pi-mono).

```bash
pi install git:github.com/rsudharshan/pi-model-picker@v1.1.0
```

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

## State

- `~/.pi/agent/model-roles.json` — role assignments and startup defaults.
- `~/.pi/agent/settings.json` — `defaultProvider`, `defaultModel`, and `modelThinkingLevels` (per-model reasoning efforts natively recognized by Pi core on model switch).

## Development

The extension is a single file: [`extensions/model-picker.ts`](extensions/model-picker.ts).
Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`) are peer dependencies supplied by pi itself — no
`npm install` needed. Try it without installing:

```bash
pi -e /path/to/pi-model-picker
```

## License

[MIT](LICENSE)
