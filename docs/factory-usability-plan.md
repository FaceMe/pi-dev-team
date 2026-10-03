# Factory UI and usability plan

Date: 2026-10-04. Status: Implementation in progress.

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
| Designer | Add a role for previews, design tokens, component states, and frontend guidance. | Pass design artifacts to architecture and frontend work. |
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

## Research

Sources checked on 2026-10-04:

- [OpenAI: Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration). Keep specialists under a manager when the manager owns the result.
- [OpenAI: Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals). Use traces to check tool selection, handoffs, and failures.
- [Anthropic: Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), 2026-03-24. Use structured handoffs and separate builders from evaluators. Check the running application.
- [Agent Skills specification](https://agentskills.io/specification). Use a clear skill description. Load instructions and references when needed.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Include keyboard access, visible focus, clear labels, and accessible component states in design and QA.
- [ASD-STE100](https://www.asd-ste100.org/). Apply Simplified Technical English to new operating instructions. The official site identifies Issue 9, dated 2025-01-15. Full rule and dictionary conformance requires a separate language review.

Provider setup details and test results will be added to the user guide when implementation is complete.
