# pi-model-picker

Two-panel model picker, role manager and reasoning-effort controller for the
[pi coding agent](https://github.com/badlogic/pi-mono).

```bash
pi install git:github.com/rsudharshan/pi-model-picker@v1.0.0
```

## Features

### Two-panel model picker

Open with `/models`, `/mp`, `/picker`, `/model-picker` or `Ctrl+Shift+M`.

- **Left panel** — providers with auth indicators and model counts.
- **Right panel** — models with context window, thinking/reasoning badges and
  vision indicators.

| Key | Action |
|---|---|
| `←` / `→` | Switch focus between provider and model panels |
| `↑` / `↓` | Navigate items in the focused panel |
| `Enter` | Switch to the highlighted model |
| `Tab` | Toggle "configured providers only" / "all providers" |
| `/` | Search / filter models |
| `Esc` | Clear search, or exit |

### Roles

Assign models to three roles and switch between them instantly:

- **daily** — the workhorse model, also the startup default
- **small** — a fast, lightweight model for tiny tasks
- **frontier** — an advanced reasoning model for complex tasks

Inside the picker:

| Key | Action |
|---|---|
| `d` | Assign highlighted model as **daily** |
| `s` | Assign highlighted model as **small** |
| `f` | Assign highlighted model as **frontier** |
| `e` | Cycle reasoning effort for the highlighted model |
| `1` / `2` / `3` | Quick-switch to daily / small / frontier |

Slash commands:

| Command | Action |
|---|---|
| `/role [daily\|small\|frontier]` | Switch role, or open the role menu |
| `/daily`, `/small`, `/tiny`, `/frontier` | Direct role activation |
| `/default [model]` | Set the startup default model |

### Reasoning effort

| Command | Action |
|---|---|
| `/effort <off\|minimal\|low\|medium\|high\|xhigh\|max>` | Set effort directly |
| `/effort` (no args) | Interactive prompt describing all seven tiers |
| `/thinking` | Alias of `/effort` |

Aliases (`min`, `med`, `hi`, `0`–`4`, …) are accepted.

### Exit

`/exit` and `/quit` shut down pi gracefully.

## State

- `~/.pi/agent/model-roles.json` — role assignments and the default model.
- `~/.pi/agent/settings.json` — `defaultProvider` / `defaultModel` are updated
  when you assign the **daily** role or set `/default`.

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
