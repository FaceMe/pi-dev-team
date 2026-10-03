# Factory UI and usability plan

Date: 2026-10-04. Status: Complete. Changes are committed locally.

## Purpose

Make the factory easy to configure, inspect, and correct from the terminal.
Keep the existing phase machine, saved state, ticket isolation, and quality gates.

## Work and acceptance criteria

| Work | Required result | Check |
| --- | --- | --- |
| Settings | Show the model and effort for each role. Use the existing model picker. | Select two roles without returning to the main menu. |
| Bulk model selection | Assign one model to all roles or a role group. Keep per-role overrides. | Save, reload, and check each assignment. |
| Navigation | Return to the parent screen. Keep the selected row where the terminal supports it. | Cancel the picker and return to the same role. |
| Spec review | Read the full draft in the CLI. Edit it or request changes before approval. | Check edit, cancel, invalid draft, and stale draft cases. |
| Task list | Show every task, its status, role, dependencies, and last result. | Check empty, blocked, active, and completed lists. |
| Subagent list | Show active workers and recent results, with model and task details. | Separate active workers from saved history after restart. |
| Designer | Add a role for previews, design tokens, component states, and frontend guidance. | Use architecture inputs. Pass design artifacts to planning and frontend work. |
| Design tools | Configure Paper, OpenDesign, and Doop through installed MCP bridges. | Use configured tools. Report missing tools without claiming success. |
| Browser QA | Run checks in Brave through project-local Playwright. Save evidence. | Check actions, assertions, screenshots, errors, and missing dependencies. |
| Documentation | Use short sentences, active voice, consistent terms, and ordered procedures. | Review new instructions against STE writing principles. |

## Implementation order

1. Improve the settings and role screens.
2. Add full spec review and an amendment loop.
3. Add task and subagent views to the main menu.
4. Add the designer role and explicit integration settings.
5. Add Brave testing with recorded evidence.
6. Run regression checks. Review the changes. Commit all work locally.

## Engineering decisions

- Keep one coordinator responsible for run state. Give specialists bounded work.
- Use files for durable handoffs. Include requirements, artifacts, checks, and unresolved items.
- Keep implementation and evaluation separate. Use test results to support completion claims.
- Load skills and external tools only when the task needs them.
- Record the model, role, task, and result. Do not present saved records as live workers.
- Use explicit integration configuration. Do not guess server addresses or tool names.
- Keep browser sessions separate from the user's normal browser profile.
- Test behavior at boundaries: navigation, persistence, process launch, and verification.
- Require explicit spec approval. Pause when no interactive UI is available.
- Ship the `factory-ui-design` and `factory-browser-qa` skills with the package.
- Serialize terminal dialogs so command screens and background approvals do not overlap.

## Completed work

| Area | Delivered behavior | Evidence |
| --- | --- | --- |
| Settings and navigation | Stage changes until Save. Assign models to one role, a group, or all roles. Return to the previous screen and selected row. | Setup tests in `factory.test.ts`; `factory-settings`, `picker-factory`, `factory-menu-settings`, and `factory-extension` tests |
| Spec review | Show the complete draft. Edit it, request changes, or pause. Validate the saved draft and reject stale approval. | `factory-spec-review`, `factory-spec-view`, and real pi resume tests |
| Run visibility | Add task and subagent screens. Show current activity in the board. Keep saved worker results separate from live workers. | `factory-board` and `factory-extension` tests |
| Design workflow | Run the designer before planning for UI work. Preserve preview assets and copy the handoff into build worktrees. | `factory-build` tests and the designer role contract |
| Tool bridges | Forward configured tools, extension paths, and provider context to the appropriate workers. | A real pi subprocess loads and calls a fixture bridge tool |
| Browser QA | Launch Brave. Record actions, assertions, screenshots, and failures. Preserve current-round evidence before cleanup. | Browser evidence tests, a direct Brave check, and a Brave tool call in a real pi worker |
| Reusable skills | Package design and browser QA workflows. | Skill validation, native pi skill discovery, and package-content check |
| User instructions | Explain setup, review, navigation, design tools, browser checks, and recovery in short, active sentences. | [Factory guide](factory.md) and the command reference |

## Validation

The final check passed on 2026-10-04: **31 test files and 397 tests passed**.
The check includes TypeScript validation and the full test suite.
The two optional Brave tests were enabled for this run.

```sh
PI_FACTORY_BROWSER_SMOKE=/tmp/pi-factory-brave-runtime npm run check
```

The temporary runtime contained Playwright. Brave ran from its installed macOS application path.
The browser checks used a local fixture page and a separate headless session.
The real worker check clicked a control and asserted the resulting text.
It saved JSON evidence and a screenshot.

Both packaged skills passed `quick_validate.py`.
Native pi discovery reported both skills with no diagnostics.
`npm pack --dry-run` included both skill files.
The final whitespace check passed.

Browser evidence uses a filesystem marker for its freshness cutoff.
This prevents wall-clock precision differences from rejecting new evidence.
The regression check covers a wall clock that is ahead of the filesystem clock.
Stale records and screenshots remain rejected.

External Paper, OpenDesign, and Doop accounts were not connected during validation.
The bridge test proves worker loading and tool selection through a fixture extension.
Use an installed pi MCP bridge and provider credentials to run those remote tools.
The factory reports missing tools without claiming a successful provider connection.
Follow the setup procedure in the [Factory guide](factory.md#configure-a-design-mcp-bridge).

## Research

Sources checked on 2026-10-04:

- [OpenAI: Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration). Keep specialists under a manager when the manager owns the result.
- [OpenAI: Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals). Use traces to check tool selection, handoffs, and failures.
- [Anthropic: Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24. Use structured handoffs and separate builders from evaluators. Check the running application.
- [Agent Skills specification](https://agentskills.io/specification). Use a clear skill description. Load instructions and references when needed.
- [Paper MCP](https://paper.design/docs/mcp). Use the documented `paper mcp` command and inspect the open design file before edits.
- [OpenDesign MCP](https://opendesign.cc/mcp/). Use its read-only design references and design-system tools.
- [Doop setup](https://doop.design/docs/get-started). Configure OAuth access and read the tool guide before design work.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Include keyboard access, visible focus, clear labels, and accessible component states in design and QA.
- [ASD-STE100](https://www.asd-ste100.org/). Apply Simplified Technical English to new operating instructions. The official site identifies Issue 9, dated 2025-01-15. Full rule and dictionary conformance requires a separate language review.

The [Factory guide](factory.md) contains provider setup details and operating procedures.
