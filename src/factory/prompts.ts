/**
 * Phase prompts. Each worker gets a self-contained brief (workers cannot see
 * the user's pi conversation) with an exact output contract. Documents are
 * written as files by the worker; structured data comes back as JSON.
 */

import { READINESS_LABELS, READINESS_TOPICS } from "./readiness.js";
import type { Readiness, ReadinessItem } from "./readiness.js";
import type { SpecValidation } from "./spec-validator.js";
import type { Answer, GateResult, Profile, SetupAnswers, Ticket } from "./types.js";

const bullet = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

export function settingsSummary(answers: SetupAnswers): string {
  const lines = [
    `Project: ${answers.projectMode === "existing" ? "add to the existing codebase in the working directory" : "new project (empty folder)"}`,
    `Stack preference: ${answers.stack === "auto" ? "none — the architect chooses" : answers.stack}`,
    `Deployment: ${answers.deploy === "none" ? "runs locally only" : answers.deploy === "config" ? "generate deploy configuration (Dockerfile + CI); the user deploys" : `deploy to ${answers.deployTarget ?? "the chosen target"}`}`,
  ];
  return lines.join("\n");
}

export function decisionsMarkdown(idea: string, answers: Answer[]): string {
  const lines = ["# Decisions", "", "## Brief", "", idea.trim(), "", "## Interview", ""];
  if (answers.length === 0) lines.push("_No questions were needed._");
  for (const a of answers) {
    lines.push(`- **${a.question}** — ${a.answer}${a.assumed ? " _(default accepted)_" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function interviewPrompt(args: {
  idea: string;
  settings: SetupAnswers;
  answers: Answer[];
  round: number;
  maxRounds: number;
  readiness?: Readiness;
  /** Synthesis digests from earlier brainstorm rounds (options, not decisions). */
  brainstorms?: string[];
}): string {
  const prior = args.answers.length
    ? args.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}${a.assumed ? " (default accepted)" : ""}`).join("\n")
    : "(none yet)";
  const checklist = (args.readiness?.items ?? READINESS_TOPICS.map((topic): ReadinessItem => ({ topic, status: "unknown" })))
    .map((item) => `- ${item.topic}: ${item.status}${item.note && item.note !== "not assessed" ? ` — ${item.note}` : ""}`)
    .join("\n");
  const topics = READINESS_TOPICS.map((topic) => `${topic} (${READINESS_LABELS[topic]})`).join(", ");
  const digests = args.brainstorms?.length
    ? `\nBrainstorm results from earlier rounds (options, not decisions):\n${args.brainstorms.map((d) => `- ${d}`).join("\n")}\n`
    : "";
  return `The user wants the factory to build this:

<brief>
${args.idea.trim()}
</brief>

Settings chosen at setup:
${settingsSummary(args.settings)}

Answers so far:
${prior}
${digests}
Readiness checklist — re-assess all nine topics every round. "known" means the
user answered; "assumed" means you recorded a safe default in the answers;
"unknown" means it still needs a question. Current state:
${checklist}

This is interview round ${args.round} of at most ${args.maxRounds}. Ask at most 4
questions whose answers change what gets built, turning "unknown" topics into
questions this round where possible. For everything else, choose a sensible
default yourself and mark the topic "assumed".

If exactly one open question is genuinely contested (several plausible answers,
high impact on what gets built), set "brainstorm" to it: the factory will ask
other model families for stanced takes and bring back options next round.
Omit the field otherwise; use it at most once per reply.

Reply with exactly one fenced json block:
\`\`\`json
{
  "ready": false,
  "questions": [
    {
      "id": "q1",
      "question": "Short question?",
      "why": "One line on why it matters",
      "options": ["Recommended option", "Alternative", "Another alternative"],
      "recommended": 0
    }
  ],
  "readiness": {
    "items": [
      { "topic": "problem", "status": "known", "note": "why" },
      { "topic": "users", "status": "assumed", "note": "single local user" },
      { "topic": "journeys", "status": "unknown", "note": "failure path unclear" }
    ]
  },
  "brainstorm": "The one contested question worth fanning out, or omit this field"
}
\`\`\`
"readiness.items" must cover all nine topics — ids: ${topics} — each with status
"known", "assumed" or "unknown" and a short note. Use "ready": true with an
empty "questions" list when no more questions are needed. Options must be
concrete answers (not "other"); the UI adds a free-text choice.`;
}

export type BrainstormStance = "divergent" | "critical" | "pragmatic";

const STANCE_GOALS: Record<BrainstormStance, string> = {
  divergent: "widen the option space",
  critical: "attack the assumptions",
  pragmatic: "simplest thing that works",
};

export function brainstormStancePrompt(args: { question: string; stance: BrainstormStance; idea: string; answers: Answer[] }): string {
  const prior = args.answers.length
    ? args.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n")
    : "(none yet)";
  return `You are one of several models asked the same contested question, each
from a different stance. Your stance: ${args.stance} — ${STANCE_GOALS[args.stance]}.

The product being built:
<brief>
${args.idea.trim()}
</brief>

Decisions so far:
${prior}

The contested question:
<question>
${args.question}
</question>

Answer strictly from your stance: ${STANCE_GOALS[args.stance]}. Give at most 3
concrete options or objections with one line of reasoning each, then the single
strongest takeaway. Plain text, at most 15 lines. Do not write files.`;
}

export function brainstormSynthesisPrompt(args: { question: string; stances: Array<{ stance: string; model: string; output: string }> }): string {
  const takes = args.stances.map((s) => `### ${s.stance} (${s.model})\n${s.output}`).join("\n\n");
  return `Several models answered the same contested question from different
stances. Synthesise their takes into one recommendation for the interview.

The question:
<question>
${args.question}
</question>

The takes:
${takes}

Reply with exactly one fenced json block:
\`\`\`json
{
  "options": ["short option name", "..."],
  "recommendation": "Which option to prefer and why, in one or two sentences",
  "risks": ["what could go wrong with the recommendation"]
}
\`\`\`
"options" lists 1-8 distinct options mentioned across the takes.`;
}

export function researchPrompt(args: { idea: string; decisionsPath: string; webAccess: boolean }): string {
  return `Research what the team needs to build this well:

<brief>
${args.idea.trim()}
</brief>

Decisions so far are in ${args.decisionsPath}.

Find: suitable current libraries/frameworks (with versions and licences), any
external APIs involved (auth, rate limits, docs), and known pitfalls.
${args.webAccess ? "Use web_search and fetch_content; cite a URL for every claim." : "Web tools are not available; rely on your knowledge and mark claims as unverified."}

Write your findings to .factory/research/notes.md (sections: Findings, Options
compared, Recommendation, Risks, Sources). Keep it under 150 lines. Then reply
with a two-line summary.`;
}

export function specPrompt(args: { idea: string; decisionsPath: string; researchPath?: string; feedback?: string }): string {
  if (args.feedback) {
    return `The user reviewed .factory/spec/spec.md and asked for changes:

<feedback>
${args.feedback}
</feedback>

Update .factory/spec/spec.md accordingly, keeping requirement IDs stable where
the requirement is unchanged. Reply with a short summary of what changed.`;
  }
  return `Write the specification for this project.

Inputs:
- The brief and the interview decisions: ${args.decisionsPath}
${args.researchPath ? `- Research notes: ${args.researchPath}\n` : ""}
Write .factory/spec/spec.md with these sections:
1. Overview — problem, users, goal (3-6 lines).
2. User stories — "As a …, I want …, so that …".
3. Functional requirements — each with an ID (FR-001, FR-002, …), a one-line
   statement, and acceptance criteria as Given/When/Then lines.
4. Non-functional requirements — IDs NFR-001…, each measurable.
5. Out of scope for this version.

Keep the scope to what the user asked for. Reply with a two-line summary.`;
}

export function specValidatorFeedback(validation: SpecValidation): string {
  const issues = validation.issues.map((issue) => `- ${issue.requirement ? `${issue.requirement}: ` : ""}${issue.message}`).join("\n");
  return `The spec validator found problems in .factory/spec/spec.md:

${issues}

Fix exactly these issues and keep everything else as written — including every
FR-xxx and NFR-xxx id whose requirement is not itself the problem. Write the
corrected .factory/spec/spec.md, then reply with a short summary.`;
}

export function architecturePrompt(args: {
  settings: SetupAnswers;
  /** Path to the approved spec; defaults to .factory/spec/spec.md. */
  specPath?: string;
  /** Block from templatesForPrompt; omit when no template fits. */
  templates?: string;
  researchPath?: string;
  feedback?: string;
}): string {
  const existing = args.settings.projectMode === "existing";
  const specPath = args.specPath ?? ".factory/spec/spec.md";
  const templateBlock = args.templates?.trim() ?? "";
  const templates = templateBlock
    ? `${templateBlock}\n\nIf one of these fits the chosen stack, start from its gates and manifests and adjust them to the project rather than inventing commands.\n`
    : "";
  const base = args.feedback
    ? `The user asked for changes to the architecture:

<feedback>
${args.feedback}
</feedback>

Update .factory/adr/0001-architecture.md — and the contracts under
.factory/contracts/ or any later ADR the feedback affects — then reply with
the full updated JSON profile (including "contracts" and "adrs").`
    : `Design the architecture for the project specified in ${specPath}.
${args.researchPath ? `Research notes are in ${args.researchPath}.\n` : ""}
${existing ? "This is an EXISTING codebase in the working directory: inspect it first and keep its stack, layout, tooling and scripts unless the spec requires otherwise." : "The working directory is a new, empty project."}
Stack preference: ${args.settings.stack === "auto" ? "none — choose what fits best" : args.settings.stack}
Deployment: ${args.settings.deploy === "none" ? "local only" : args.settings.deploy === "config" ? "include a Dockerfile and CI; the user deploys" : `will be deployed to ${args.settings.deployTarget}`}

${templates}Write .factory/adr/0001-architecture.md with: Context, Decision (stack with
versions, directory layout, module boundaries, data model, API/CLI surface,
error handling, logging, testing approach), Conventions (naming, structure),
Consequences, and Alternatives considered. Record any further significant
standalone decision (storage, auth, a new runtime dependency) as its own
numbered ADR under .factory/adr/ — 0002-<slug>.md, 0003-<slug>.md, … — rather
than growing 0001.

When the project has an API, data or shared-type surface, write the contract
files under .factory/contracts/ as the source of truth the builders implement
against: an API spec (openapi.yaml or a typed api.ts), a data schema
(schema.sql or typed models), shared types — the smallest set that pins every
interface. When it has no such surface (for example a pure CLI), write no
contracts.`;

  return `${base}

Then reply with exactly one fenced json block — the stack profile the factory
uses to verify every change. Commands run from the repository root, must be
non-interactive, and must exit non-zero on failure:
\`\`\`json
{
  "stack": "e.g. TypeScript 5 + Node 22 + Fastify + Vitest",
  "gates": {
    "install": "npm install",
    "build": "npm run build",
    "typecheck": "npx tsc --noEmit",
    "lint": "npm run lint",
    "test": "npm test"
  },
  "manifests": ["package.json"],
  "contracts": ["openapi.yaml"],
  "adrs": ["0001-architecture.md"]
}
\`\`\`
Include only gates the stack actually has; "install" and "test" are required.
"manifests" lists the dependency files whose change requires re-running install.
"contracts" lists the exact file names you wrote under .factory/contracts/;
omit it when there are none. "adrs" lists every ADR file name under
.factory/adr/, starting with 0001-architecture.md.`;
}

export function planningPrompt(args: { profile: Profile; contracts?: string[]; feedback?: string; errors?: string[] }): string {
  if (args.errors?.length) {
    return `Your ticket plan had problems:
${bullet(args.errors)}

Reply again with the corrected complete plan as one fenced json block.`;
  }
  const feedback = args.feedback ? `\nThe user asked for these changes to the previous plan:\n<feedback>\n${args.feedback}\n</feedback>\n` : "";
  const contracts = args.contracts?.length
    ? `\nContracts (source of truth for every interface): ${args.contracts.map((c) => `.factory/contracts/${c}`).join(", ")}. Foundation tickets implement these contracts first; dependent tickets build against them rather than guessing interfaces.\n`
    : "";
  return `Plan the build for the project in .factory/spec/spec.md, following the
architecture in .factory/adr/0001-architecture.md.
Stack: ${args.profile.stack}
Gates: ${args.profile.gates.map((g) => `${g.name}: \`${g.command}\``).join("; ")}
${contracts}${feedback}
A separate skeleton step already creates the project scaffold, tooling, CI and
a passing empty test suite — do not plan that. Plan the feature work as small,
ordered tickets. Each ticket must leave every gate passing.

Roles: "backend" (server, data, CLI, libraries), "frontend" (UI), "devops"
(build/deploy config), "docs" (documentation only).

Reply with exactly one fenced json block:
\`\`\`json
{
  "tickets": [
    {
      "id": "T-001",
      "title": "Short imperative title",
      "role": "backend",
      "dependsOn": [],
      "requirements": ["FR-001"],
      "brief": "Self-contained description: what to build, where, and how it fits the architecture.",
      "acceptance": ["Given … When … Then …"],
      "writeScope": ["src/todo/**", "tests/todo/**"]
    }
  ]
}
\`\`\`
Rules: ids T-001, T-002, … in execution order; dependsOn only references
earlier tickets; every FR-xxx in the spec appears in at least one ticket;
writeScope covers the ticket's source and test files (globs allowed);
prefer 3-15 tickets.`;
}

export function skeletonPrompt(args: { settings: SetupAnswers; profile: Profile; feedback?: string }): string {
  if (args.feedback) {
    return `The gates still fail:

${args.feedback}

Fix the skeleton so every gate passes, run the gates yourself, then report.`;
  }
  const existing = args.settings.projectMode === "existing";
  return `${existing ? "This is an existing codebase. Make sure its tooling supports the gates below: add what is missing (for example a test runner or a CI workflow) without restructuring the project." : "Create the walking skeleton for a new project."}

Follow the architecture in docs/adr/0001-architecture.md and the spec in docs/spec.md.
Stack: ${args.profile.stack}

The gates, run from the repository root, must all pass when you finish:
${args.profile.gates.map((g) => `- ${g.name}: \`${g.command}\``).join("\n")}

Create: the directory layout, dependency manifests, build/lint/test tooling,
one trivial passing test, a .gitignore (include .factory/), and a CI workflow
(.github/workflows/ci.yml) that runs the same gate commands.
${args.settings.deploy !== "none" ? "Also add deployment configuration (a production Dockerfile and any config the target needs) and document required environment variables in .env.example.\n" : ""}Do not implement features yet. Run every gate command yourself before you finish,
then report what you created and the gate results.`;
}

export function qaPrompt(ticket: Ticket, profile: Profile, testScope: string[]): string {
  const test = profile.gates.find((g) => g.name === "test");
  return `Write the acceptance tests for ticket ${ticket.id}: ${ticket.title} — before it is implemented.

${ticket.brief}

Requirements covered: ${ticket.requirements.join(", ") || "(none listed)"} — see docs/spec.md${profile.contracts?.length ? "; interfaces are pinned by docs/contracts/" : ""}.
Acceptance criteria (at least one test each):
${bullet(ticket.acceptance)}

You may change only test files matching: ${testScope.join(", ")}
The test command is \`${test?.command ?? "the project's test gate"}\`. Run it: your new tests should fail
because the feature is missing (not because of a syntax error), and every
existing test should still pass.

Reply with the test files you wrote and the criterion each one covers.`;
}

export function ticketPrompt(ticket: Ticket, profile: Profile): string {
  const qa = ticket.qaTests?.length
    ? `QA already wrote failing acceptance tests for this ticket: ${ticket.qaTests.join(", ")}.
Make them pass. Do not weaken, skip or delete them; if one is genuinely wrong,
fix it minimally and explain why in your report.

`
    : "Write the tests for the acceptance criteria first, then the implementation.\n";
  return `Implement ticket ${ticket.id}: ${ticket.title}

${ticket.brief}

Requirements covered: ${ticket.requirements.join(", ") || "(none listed)"} — see docs/spec.md.
Acceptance criteria:
${bullet(ticket.acceptance)}

You may change only files matching: ${ticket.writeScope.join(", ")}
(lockfiles updated by the package manager are fine).

Before finishing, run these gates from the repository root and make them pass:
${profile.gates.map((g) => `- ${g.name}: \`${g.command}\``).join("\n")}

${qa}Report what you changed and which tests cover each acceptance criterion.`;
}

export function gateFeedbackPrompt(ticket: Ticket, failure: string): string {
  return `The factory ran the gates on your change for ${ticket.id} and they failed:

${failure}

Fix the cause (not the test), run the gates again yourself, and report.`;
}

export function reviewFeedbackPrompt(ticket: Ticket, findings: string): string {
  return `The reviewer requested changes to ${ticket.id}:

${findings}

Address every blocking finding, keep the gates passing, and report what you changed.`;
}

export function secretFeedbackPrompt(ticket: Ticket, findings: string): string {
  return `The factory's secret scan blocked ${ticket.id} from merging. These look like real credentials:

${findings}

Remove them from the code and from any committed file. Read secrets from
environment variables instead, and list each variable (with a placeholder
value) in .env.example if that file is in your scope. Keep the gates passing
and report what you changed.`;
}

export function conflictPrompt(ticket: Ticket, files: string[]): string {
  return `Other tickets were merged into the integration branch while you worked on ${ticket.id}.
The factory merged the integration branch into your branch and these files
conflict:
${bullet(files)}

Resolve every conflict (remove all <<<<<<< ======= >>>>>>> markers), keeping
both your change and the integrated work, then run the gates and report.`;
}

export function integrationFeedbackPrompt(ticket: Ticket, failure: string): string {
  return `${ticket.id} passed its gates on its own branch, but the gates failed after it was merged
with the other finished tickets on the integration branch. The factory undid
that merge and brought the integrated work into your branch, so you can now
reproduce the failure locally:

${failure}

Fix your change so it works together with the integrated code (do not change
other tickets' files), run the gates, and report.`;
}

export function scopeFeedback(files: string[], scope: string[]): string {
  return `Note: you changed files outside this ticket's write scope (${scope.join(", ")}). The factory reverted them:
${bullet(files)}
If the ticket genuinely needs them, say so in your report instead of changing them.`;
}

export function reviewPrompt(args: { ticket: Ticket; diff: string; gates: GateResult[] }): string {
  return `Review the change for ticket ${args.ticket.id}: ${args.ticket.title}

Ticket brief:
${args.ticket.brief}

Acceptance criteria:
${bullet(args.ticket.acceptance)}

The spec is in docs/spec.md and conventions in docs/adr/0001-architecture.md.
Gate results (run by the factory): ${args.gates.map((g) => `${g.gate} ${g.ok ? "passed" : "FAILED"}`).join(", ")}

The diff:
\`\`\`diff
${args.diff}
\`\`\`

Reply with exactly one fenced json block:
\`\`\`json
{
  "verdict": "approve",
  "findings": [
    { "severity": "blocking", "file": "src/x.ts", "issue": "What is wrong and how to fix it" }
  ]
}
\`\`\`
verdict is "approve" or "changes". Use "changes" only when at least one finding
is "blocking" (a real defect, a missed acceptance criterion, or a spec
violation). Minor findings use severity "minor".`;
}

export function docsPrompt(args: { settings: SetupAnswers; profile: Profile; tickets: Ticket[] }): string {
  const done = args.tickets.filter((t) => t.status === "done").map((t) => `${t.id} ${t.title}`);
  return `Document the project for the people and agents who will maintain it.

Stack: ${args.profile.stack}
Gates: ${args.profile.gates.map((g) => `${g.name}: \`${g.command}\``).join("; ")}
Delivered tickets:
${bullet(done)}
Specification: docs/spec.md. Architecture decision: docs/adr/0001-architecture.md.

Write or update README.md, docs/architecture.md, AGENTS.md and CHANGELOG.md as
described in your role. Verify commands by running them. Change documentation
files only. Reply with a short summary.`;
}

export function deployPrompt(args: { target: string; profile: Profile }): string {
  return `The user approved deploying this project to ${args.target} now.

Use the already-installed and logged-in CLI for ${args.target}; do not create
new accounts or store credentials. Follow the deployment configuration in the
repository. If something is missing (an app name, a region, a secret), stop and
report exactly what the user must provide instead of guessing.

Report the deployed URL (or the exact failure) at the end.`;
}

export function exploratoryQaPrompt(args: { profile: Profile; tickets: Ticket[]; requirements: string[]; round: number; fixed: Ticket[] }): string {
  const delivered = args.tickets.filter((t) => t.status === "done" && t.kind !== "bug").map((t) => `${t.id} ${t.title} (${t.requirements.join(", ") || "no requirement"})`);
  const fixed = args.fixed.map((t) => `${t.id} ${t.title}`);
  return `Exploratory QA, round ${args.round}: try the integrated build the way a real user would.

The specification is docs/spec.md (requirements: ${args.requirements.join(", ") || "see the spec"}).
Stack: ${args.profile.stack}. Gates: ${args.profile.gates.map((g) => `${g.name}: \`${g.command}\``).join("; ")}.
Delivered tickets:
${bullet(delivered.length ? delivered : ["(none)"])}
${fixed.length ? `Bugs fixed since the last round (check each is really fixed):\n${bullet(fixed)}\n` : ""}
Do not read the tests and call it done: the unit tests already pass. Run the
software itself — the CLI with real arguments, the API with real requests (start
the server in the background with output to a log, and stop it afterwards), the
UI in the running browser (use configured Brave automation where available) — and walk each requirement's acceptance criteria end to end.
Then go off the happy path: empty and invalid input, missing files or
configuration, large input, repeated or out-of-order actions, error messages.

Rules: do not change any tracked file (scratch files go in /tmp); report what you
observed, with the exact command and output as evidence. Severity: "critical"
(crash, data loss, security, a core requirement unusable), "major" (a requirement
or acceptance criterion not met, wrong result), "minor" (cosmetic, unclear
message, edge case outside the spec).

Reply with only this JSON:
\`\`\`json
{
  "summary": "two or three sentences",
  "checks": [{ "requirement": "FR-001", "result": "pass|fail|untested", "evidence": "command → output; for UI include Brave URL, viewport, actions and screenshot paths" }],
  "bugs": [{ "title": "short", "severity": "critical|major|minor", "requirement": "FR-001",
             "steps": ["exact step"], "expected": "…", "actual": "…", "evidence": "command and output" }]
}
\`\`\`
Use "bugs": [] when you found none.`;
}

export function contributorPrompt(args: { idea: string }): string {
  return `You are a new contributor who has just cloned this repository. Nobody can help
you: use only what the repository's own documentation tells you (README.md,
AGENTS.md, docs/, CHANGELOG.md, comments). The project: ${args.idea}

1. Follow the docs to set the project up, run its tests and run it. Use the
   commands exactly as documented; when a documented step is missing, wrong or
   unclear, note it as a gap (and work around it if you can).
2. Make one small, realistic extension the way the docs say changes are made:
   for example a new option, a validation rule, or a small endpoint or command,
   with a test. Follow the conventions in AGENTS.md. Keep it to a few files.
3. Run the tests again; they must pass with your change.

Reply with only this JSON:
\`\`\`json
{
  "setup": ["commands you ran to set up, as documented"],
  "test": ["the documented test command(s)"],
  "run": ["the documented command(s) that run the software"],
  "extension": { "description": "what you added", "files": ["changed files"] },
  "gaps": [{ "doc": "README.md", "problem": "what was missing, wrong or unclear", "blocking": true }],
  "ok": true
}
\`\`\`
"blocking" means you could not continue without guessing. Set "ok" to false
when the docs alone were not enough to set up, test or extend the project.`;
}

export function docsGapPrompt(args: { reasons: string[]; gaps: Array<{ doc: string; problem: string; blocking: boolean }> }): string {
  return `A new contributor tried to set up, test and extend the project using only its
documentation, and got stuck:

${bullet(args.reasons)}
${args.gaps.length ? `\nGaps they reported:\n${bullet(args.gaps.map((g) => `${g.blocking ? "[blocking] " : ""}${g.doc}: ${g.problem}`))}\n` : ""}
Fix the documentation (README.md, AGENTS.md, docs/) so the next contributor
succeeds. Run every command you document to confirm it works. Change
documentation files only. Reply with a short summary of what you fixed.`;
}

/** Concrete design contract, usable even without a connected design server. */
export function designPrompt(args: { idea: string; settings: SetupAnswers; spec: string }): string {
  return `Design the user interface for: ${args.idea}

${settingsSummary(args.settings)}

Specification:
${args.spec}

Read the existing UI and docs/architecture.md if present. Create these artifacts:
- .factory/design/design-system.md: tokens, typography, spacing, responsive layout,
  accessible components, and their loading/empty/error/success/focus states.
- .factory/design/handoff.md: screen/component inventory mapped to FR identifiers,
  interactions, responsive rules, copy, assets and frontend acceptance checks.
- .factory/design/preview.html: self-contained responsive HTML/CSS preview of core
  journeys, openable locally without dependencies. Use real representative content.
- .factory/design/evidence.json: {"integrations": [{"provider": "paper|opendesign|doop",
  "status": "used|unavailable|not-configured", "tools": [], "artifacts": [], "reason": "..."}],
  "preview": ".factory/design/preview.html", "screenshots": []}.

Use every enabled design provider for an appropriate task when its tools are
loaded (e.g. preview canvas, reusable design system, handoff/export). Inspect its
actual tool schemas and current project first. If unavailable, record the reason
and complete local artifacts. Copy usable exported assets into the design scope.
Record only real tool calls and returned artifact links. Configuration is not a
successful connection. If browser tooling is configured, inspect the local
preview in Brave and capture evidence; otherwise mark browser review untested.
Do not fabricate screenshots, remote URLs or successful browser checks.
Reply with artifact paths, design decisions, provider status and open limitations.`;
}
