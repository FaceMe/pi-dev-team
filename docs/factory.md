# Factory user guide

Use `/factory` to plan, build, test, and document a project with specialist agents.
A **role** defines a worker's instructions and tools.
A **ticket** is one task with requirements, acceptance checks, and a file scope.
A **gate** is a command that must pass before the factory continues.

For the implementation plan and research, read [Factory usability plan](factory-usability-plan.md).
The [original roadmap](software-factory-plan.md) records the earlier design.

## Start a run

1. Open pi in the project folder.
2. Run `/factory doctor`.
3. Log in to at least one model provider if no model is available.
4. Run `/factory new <idea>`.
5. Check the setup answers.
6. Select **Start with these answers**.
7. Answer the interview questions.
8. Read and approve the specification draft.

The factory saves project settings in `.factory/project.json`.
It saves the team preset, role pins, autonomy, and research preference as user defaults.
User defaults apply to subsequent projects.

`/factory settings` changes settings without starting a run.
Select **Save settings** to save the changes.
Press Escape from the settings screen to discard the changes.

## Picking models per role

1. Open `/factory settings`.
2. Select **Team**.
3. Select **configure role models…**.
4. Select a role.
5. Select a model in the model picker.
6. Repeat steps 4 and 5 for other roles.
7. Select **Back** to return to Team.
8. Select **Back** to return to Settings.
9. Select **Save settings**.

The role list shows the current provider, model, effort, and pin state.
The model picker starts at the current assignment.
Use `/` to search for a model. Use `e` to select a supported reasoning effort.
Save or cancel the model choice to return to the role list.
The terminal keeps the selected row when a nested screen closes.

Use **Assign all roles…** to set one model for the full team.
Use a role group to set one model for related work:

| Group | Roles |
| --- | --- |
| Planning and review | analyst, researcher, architect, planner, reviewer |
| Build | backend, frontend, devops |
| Design and frontend | designer, frontend |
| Test and documentation | qa, contributor, docs |

A bulk assignment replaces the pins for the selected group.
You can then change individual roles.
Use **clear pinned models** in Team to return all roles to automatic selection.

`/factory roles` opens the role list directly.
Select **Save settings** to save the assignments.
Escape from this list discards the pending assignments.

Pins take priority over automatic model selection.
Without a pin, the `balanced` preset uses each role's normal model tier.
The `cheap` preset uses a lower tier where permitted.
The `best` preset uses the strongest available tier.
Judgement roles do not fall below the daily tier when a suitable model is available.
The reviewer uses a different model family when one is suitable.

A running worker keeps its assigned model.
New model settings apply on the next run or resume.
The factory does not require a particular provider or model ID.

## Review and amend the specification

The specification opens in a read-only terminal viewer before approval.
Use these keys:

| Key | Action |
| --- | --- |
| Up / Down | Scroll one line |
| Page Up / Page Down | Scroll one page |
| Home / End | Go to the start or end |
| Escape / Enter / q | Close the viewer |

Then select one action:

- **Approve** accepts the displayed draft after validation.
- **View full specification** opens the complete draft again.
- **Edit draft…** opens the CLI editor with the current text.
- **Request changes…** sends your amendment to the analyst.
- **Pause the factory** saves the run for later.

After an edit or amendment, the factory validates and displays the new draft.
It rejects approval if the file changed during review.
A cancelled edit preserves the previous draft.
An invalid saved edit remains available for correction after a restart.
If you pause during an edit, close the editor to let the pause finish.

Requirements must have unique IDs and acceptance criteria.
Each functional requirement needs Given/When/Then criteria and a source in the brief, interview, or assumptions.
Each non-functional requirement needs a measurable threshold.
The validator writes its result to `.factory/spec/validation.json`.
The approved text is saved to `.factory/spec/approved.md`.

Use `/factory spec` to read the current draft at any time.
This command does not change an approved run.
To amend a paused draft, use `/factory resume` and select an edit action at the spec gate.
A change to an already implemented requirement needs a new run with the revised brief.

In a session without interactive UI, the factory records the full draft and pauses for approval.
It does not approve the draft automatically.
Resume the run in an interactive session to review it.

## Watching a run

The `/factory` menu includes task, subagent, specification, board, and settings screens.
Closing a screen returns to the menu.
The menu also provides resume, pause, setup checks, and new-project actions.

`/factory tasks` shows every ticket.
Each entry includes its state, role, unmet dependencies, and last attempt result.
`/factory tasks T-001` also shows its brief, file scope, requirements, and acceptance checks.

`/factory agents` shows live workers with their models and current activity.
It then shows the most recent worker results for this run.
After a restart, completed records remain visible as history.
They are not shown as live processes.

The compact board updates as workers report activity.
It shows phase, progress, spend, active workers, and a limited set of open tickets.
Use the full task or subagent list to inspect the remaining entries.

Use `/factory trace <role|ticket>` for tool activity.
Use `/factory history <ticket>` for attempts, test results, review findings, and merges.

## Designer and design tools

The designer runs for projects whose brief or spec describes a user interface.
It prepares the design during architecture, before the build plan.
It produces these files under `.factory/design/`:

| File | Content |
| --- | --- |
| `design-system.md` | Colors, typography, spacing, components, states, and accessibility rules |
| `handoff.md` | Screens and components linked to requirements; implementation guidance |
| `preview.html` | A local responsive preview of the main user journeys |
| `evidence.json` | Provider results, preview paths, and limitations |
| `inputs.json` | The spec and profile used for this design |

The build receives the design files under `docs/design/`.
Frontend workers use this handoff when they implement the UI.
If the spec or architecture changes before planning, the designer refreshes its output.

The designer uses enabled Paper, OpenDesign, and Doop tools for appropriate tasks.
It reports unavailable tools and completes the local design files.
An external connection is proven only by a successful tool call.
A configured tool name alone does not prove a connection.

### Configure a design MCP bridge

MCP means Model Context Protocol. A pi MCP bridge exposes server tools as pi extension tools.
The factory uses that bridge; it does not create account credentials or install a server automatically.

1. Set up the provider through a pi MCP bridge.
2. Complete the provider's sign-in process if required.
3. Reload pi so the tools are available.
4. Open `/factory settings` and select **Design/browser**.
5. Select a provider and enable it.
6. Select exact names from the loaded tool list, or enter the bridge's exact tool names.
7. Set explicit bridge extension paths if pi does not load them automatically.
8. Add the design project or document context.
9. Return to the integration screen and select **Save integrations**.
10. Select **Save settings**.
11. Run `/factory doctor` to check the local setup.

`/factory integrations` opens the same integration screen directly.
Settings remain local to this project.
A saved change updates a paused run for its next resume.
Active workers keep their current tools.

Current provider setup references, checked on 2026-10-04:

| Provider | Server setup | Purpose |
| --- | --- | --- |
| [Paper](https://paper.design/docs/mcp) | Recommended command: `paper mcp`. Paper Desktop installs the CLI. | Create and inspect design canvases and previews. |
| [OpenDesign](https://opendesign.cc/mcp/) | HTTP endpoint: `https://opendesign.cc/mcp/http`. A documented stdio script is also available. | Read design references, design systems, specifications, and critique guidance. This server is read-only. |
| [Doop](https://doop.design/docs/get-started) | Endpoint: `https://doop.design/mcp`. Complete OAuth sign-in. | Create and refine design work. Read `get_guide` before use. |

Follow the provider's current instructions when you configure the bridge.
Some bridges add a prefix to tool names. Use the names that pi actually exposes.
Store credentials in the bridge's credential store, not in factory settings.

## Brave browser testing

1. Install Brave on the machine that runs pi workers.
2. Install `playwright` or `@playwright/test` in the application project.
3. Open **Settings → Design/browser → Brave browser QA**.
4. Enable browser QA.
5. Use the detected executable, or enter the absolute path to Brave.
6. Save the integration settings and the factory settings.
7. Run `/factory doctor` to check Brave and the Playwright runtime.

The factory exposes `factory_browser_qa` to QA, designer, and frontend workers when enabled.
The tool launches a separate headless Brave process through Playwright.
It does not use your normal browser profile.
A worker must start the local application server before testing an HTTP URL.

The tool supports `click`, `fill`, `press`, and `assertText` steps with CSS selectors.
It records the URL, viewport, actions, observed text, console errors, screenshot, and result.
A passing result requires a non-empty text assertion.
Navigation or clicks alone do not prove acceptance.
HTTP errors, console errors, and failed actions produce a failed result.
Missing Brave or Playwright produces `untested`.

During verification, enabled browser QA runs even if general exploratory QA is disabled.
Evidence must come from the current round and include a real screenshot.
The factory copies that evidence to `.factory/qa/browser-round-<n>/` before worktree cleanup.
Missing or failed evidence produces a verification issue and enters the existing repair flow.
A passing browser record proves only the recorded checks.
The QA report must state which requirements were tested and which remain untested.

## Packaged skills

The package includes `factory-ui-design` and `factory-browser-qa` skills.
Pi discovers them from the package manifest.
Workers load the relevant skill when its description matches the assignment.
The design skill covers provider use and frontend handoffs.
The browser skill covers observable acceptance checks and evidence reports.

## What a run looks like

| Phase | Result |
| --- | --- |
| Discovery | Interview answers, assumptions, research, and a readiness checklist |
| Spec | Validated specification and explicit approval |
| Architecture | Architecture decisions, interface contracts, stack profile, and UI design where needed |
| Planning | A task graph and a requirement-to-ticket map |
| Skeleton | A working project base that passes the gates |
| Build | Implemented tickets, tests, review results, and integration merges |
| Verify | Integration gates, exploratory checks, browser evidence when enabled, and repair tickets |
| Docs | User and developer instructions; a new-contributor check |
| Release | Local merge, optional version tag, release notes, and retrospective |

Autonomy controls the normal approval points:

| Preset | Required approval |
| --- | --- |
| `auto` | Specification |
| `balanced` | Specification and build plan |
| `careful` | Each phase and each ticket commit |

Budget limits, unresolved failures, and deployment can require additional input.
A deployment always requires explicit approval.

## Planning and traceability

The architect writes decisions under `.factory/adr/`.
It writes shared interface contracts under `.factory/contracts/` when the project needs them.
The profile lists the files and the gate commands.
The factory checks that each listed file exists.

The planner gives each ticket a role, requirements, dependencies, acceptance checks, and a file scope.
The factory rejects duplicate IDs, missing dependencies, dependency cycles, and missing functional requirement coverage.
Parallel tickets must have disjoint write scopes.
Tickets that share files must have a dependency that orders their work.
The approved plan is saved in `.factory/tickets.json`.
The requirement map is saved in `.factory/traceability.json`.

## The build loop

Each ticket uses its own git worktree and branch.
The scheduler starts independent tickets up to the configured parallel limit.

1. QA writes acceptance tests before implementation when this feature is enabled.
2. The assigned builder implements the ticket.
3. The factory checks the file scope and scans the diff for secrets.
4. The factory runs the profile gates.
5. A reviewer checks the change against the requirements and test evidence.
6. The ticket merges into the integration branch.
7. The gates run again on the integrated result.

Failures return to the builder with the failing checks or review findings.
Repeated failures can use a stronger model from the role's escalation ladder.
Unresolved failures pause for a decision.

Optional `build` settings belong in user defaults or `.factory/project.json`:

```json
{
  "build": {
    "maxParallel": 3,
    "budgetBreaker": 0.8,
    "escalationBreaker": 0.3,
    "qa": true,
    "exploratoryQa": true,
    "qaRounds": 2,
    "bugSeverity": "major",
    "contributorCheck": true,
    "tagRelease": true
  }
}
```

## Verification and release

The factory runs all gates on the integrated build with a fresh dependency install.
QA then tests the application against the requirements.
A report records reproduction steps, expected results, actual results, and severity.
Findings at or above the severity threshold become repair tickets.
The default limit permits two repair rounds.

After the repair limit, `auto` can release with known issues recorded.
`balanced` and `careful` ask whether to continue repairs, pause, or release with those issues.
Read `.factory/qa/open-bugs.json` and the release notes before using a release.

The documentation worker writes the README, architecture guide, AGENTS.md, and CHANGELOG.
Its instructions require ASD-STE100 Simplified Technical English writing principles.
A separate contributor uses only these documents to set up and extend a temporary clone.
The factory records the result and removes the temporary clone.

Release gates and the secret scan must pass before the local merge.
The factory can add a local version tag.
It does not push the merge or tag.
The retrospective records cost, failures, escalations, and follow-up work.

## Commands

| Command | Action |
| --- | --- |
| `/factory` | Open the menu |
| `/factory new [idea]` | Configure and start a run |
| `/factory settings` | Change settings without starting a run |
| `/factory roles` | Configure role models and effort |
| `/factory integrations` | Configure design tools and Brave QA |
| `/factory spec` | Read the full current specification |
| `/factory tasks [id]` | List tasks or inspect one task |
| `/factory agents` | Show live workers and recent results |
| `/factory status` | Show phase, progress, spend, and last stop |
| `/factory board` | Show the compact board |
| `/factory trace [ticket\|role]` | Show the last recorded worker trace |
| `/factory history [ticket]` | Show attempts, checks, reviews, and merges |
| `/factory cost` | Show spend by phase, role, model, and ticket |
| `/factory qa [round]` | Show QA and contributor reports |
| `/factory retro` | Show the retrospective |
| `/factory pause` | Stop the active run at its next cancellation point |
| `/factory resume` | Continue the saved run |
| `/factory doctor [probe]` | Check setup; optionally probe team model tool use |
| `/factory team [balanced\|cheap\|best\|refresh]` | Show or change automatic team selection |
| `/factory autonomy auto\|balanced\|careful` | Change approval policy |
| `/factory run <role> <brief>` | Run one role with read-only file scope |
| `/factory demo` | Start a sample CLI project in a temporary folder |
| `/factory help` | Show command help |

## Resuming

The lock file stores phase, tickets, attempts, spend, budgets, and run settings.
Start pi in the same folder and select **Resume the run now**, or use `/factory resume`.
The factory rebuilds the team from current model availability and saved role pins.

Settings use the saved run snapshot unless you explicitly change them through Settings.
A cancelled new-run setup leaves the previous lock in place.
A confirmed new run archives the previous lock under `.factory/runs/`.
Legacy `state.json` files migrate to `factory.lock.json` when loaded.

The budget prompt appears at the configured threshold, normally 80 percent.
It can raise the budget by 50 percent or pause the run.
A saved budget increase remains in the lock.

## Cost and traces

The append-only ledger records worker roles, models, task IDs, cost, tokens, and bounded tool traces.
Cost reports use the current run ID to exclude older runs.
The all-frontier savings figure is an estimate based on current model prices.
It is not an invoice or a guaranteed saving.

## What lands in `.factory/`

| Path | Content |
| --- | --- |
| `factory.lock.json` | Current run state and settings |
| `project.json` | Project settings |
| `runs/` | Archived locks |
| `brief.md` | Original project idea |
| `spec/` | Draft, approved snapshot, decisions, assumptions, and validation |
| `design/` | Preview, design system, evidence, and frontend handoff |
| `research/` | Research and brainstorm notes |
| `adr/` and `contracts/` | Decisions and shared interface definitions |
| `profile.json` | Stack, gate commands, and dependency manifests |
| `tickets.json` and `traceability.json` | Work plan and requirement coverage |
| `reviews/` | Review findings per attempt |
| `qa/` | QA reports, browser evidence, and open issues |
| `contributor.md` and `contributor.json` | Documentation usability checks |
| `report.md`, `release-notes.md`, and `retro.md` | Delivery reports |
| `ledger.jsonl` | Worker and gate history |
| `sessions/` and `worktrees/` | Temporary worker data; excluded from git |

## Guard rails

File tools enforce the worker's assigned scope.
The build loop also checks the resulting diff.
Commands that publish, deploy, rewrite history, or access known credential stores are blocked by the factory guard.
This guard is not an operating-system sandbox.
Use a sandbox for untrusted projects or tool bridges.

Only configured design and browser tool names are added to the appropriate worker roles.
MCP permissions also depend on the bridge and the provider account.
The doctor checks local configuration and reports whether a connection was actually probed.

## Documentation convention

Use short sentences, active voice, and one instruction per sentence.
Use the same term for the same component.
Preserve exact command names, paths, and API identifiers.
Use ordered steps for procedures and tables for parallel options.
These rules follow [ASD-STE100](https://www.asd-ste100.org/) writing principles.
A formal vocabulary and rule review is required before claiming full STE conformance.
