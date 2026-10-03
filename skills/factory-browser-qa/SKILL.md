---
name: factory-browser-qa
description: Test factory application journeys in Brave with factory_browser_qa and record acceptance evidence. Use for enabled browser QA or a designer preview check, not for ordinary browser research.
---

# Factory browser QA

Read the ticket's acceptance checks and `docs/spec.md`.
Select the journeys and failure paths that need browser evidence.
Use the configured Brave executable and project-local Playwright runtime.
If either dependency is missing, report the checks as untested.

Start the application with the repository's documented command.
Wait until its local URL responds before testing.
Use fixture data and a separate browser session.

Call `factory_browser_qa` with the URL, viewport, and ordered steps.
Use CSS selectors for `click`, `fill`, `press`, and `assertText` actions.
Each acceptance check needs an assertion of its expected result.
An `assertText` step must include non-empty expected text.
Navigation, clicks, and screenshots alone do not prove acceptance.

Example steps for a save journey:

```json
[
  { "action": "fill", "selector": "#name", "value": "Sample" },
  { "action": "click", "selector": "button[type=submit]" },
  { "action": "assertText", "selector": "[role=status]", "value": "Saved" }
]
```

Test keyboard paths and a narrow viewport when the requirements need them.
Record the actual result from each call. Failed actions, console errors, and HTTP errors need investigation.
Do not change a failed result to pass based on a visual guess.

The tool writes JSON and screenshots under `.factory/qa/browser/` when the worker has that scope.
Use those current-run files as evidence. Do not fabricate records or reuse an earlier screenshot as a new check.
Link each checked requirement to its observed result in the QA report.
List untested requirements and the reason they could not be tested.
Stop any application server started for the check when the work is complete.

Use short, active sentences in reports. Preserve exact selectors, URLs, commands, and requirement IDs.
