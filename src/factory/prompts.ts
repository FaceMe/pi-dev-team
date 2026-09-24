/**
 * Phase prompts. Each worker gets a self-contained brief (workers cannot see
 * the user's pi conversation) with an exact output contract. Documents are
 * written as files by the worker; structured data comes back as JSON.
 */

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
}): string {
  const prior = args.answers.length
    ? args.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}${a.assumed ? " (default accepted)" : ""}`).join("\n")
    : "(none yet)";
  return `The user wants the factory to build this:

<brief>
${args.idea.trim()}
</brief>

Settings chosen at setup:
${settingsSummary(args.settings)}

Answers so far:
${prior}

This is interview round ${args.round} of at most ${args.maxRounds}. Decide whether you
can write a complete, testable specification now. If important unknowns remain
(users, core flows, data, integrations, constraints, what "done" looks like),
ask at most 4 questions whose answers change what gets built. For everything
else, choose a sensible default yourself.

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
  ]
}
\`\`\`
Use "ready": true with an empty "questions" list when no more questions are needed.
Options must be concrete answers (not "other"); the UI adds a free-text choice.`;
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

Update .factory/spec/spec.md (and .factory/spec/assumptions.md if affected)
accordingly, keeping requirement IDs stable where the requirement is unchanged.
Reply with a short summary of what changed.`;
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

Also write .factory/spec/assumptions.md listing every assumption you made
where the user did not decide explicitly (one line each, so they can correct it).

Keep the scope to what the user asked for. Reply with a two-line summary.`;
}

export function architecturePrompt(args: { settings: SetupAnswers; researchPath?: string; feedback?: string }): string {
  const existing = args.settings.projectMode === "existing";
  const base = args.feedback
    ? `The user asked for changes to the architecture:

<feedback>
${args.feedback}
</feedback>

Update .factory/adr/0001-architecture.md and reply with the full updated JSON profile.`
    : `Design the architecture for the project specified in .factory/spec/spec.md.
${args.researchPath ? `Research notes are in ${args.researchPath}.\n` : ""}
${existing ? "This is an EXISTING codebase in the working directory: inspect it first and keep its stack, layout, tooling and scripts unless the spec requires otherwise." : "The working directory is a new, empty project."}
Stack preference: ${args.settings.stack === "auto" ? "none — choose what fits best" : args.settings.stack}
Deployment: ${args.settings.deploy === "none" ? "local only" : args.settings.deploy === "config" ? "include a Dockerfile and CI; the user deploys" : `will be deployed to ${args.settings.deployTarget}`}

Write .factory/adr/0001-architecture.md with: Context, Decision (stack with
versions, directory layout, module boundaries, data model, API/CLI surface,
error handling, logging, testing approach), Conventions (naming, structure),
Consequences, and Alternatives considered.`;

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
  "manifests": ["package.json"]
}
\`\`\`
Include only gates the stack actually has; "install" and "test" are required.
"manifests" lists the dependency files whose change requires re-running install.`;
}

export function planningPrompt(args: { profile: Profile; feedback?: string; errors?: string[] }): string {
  if (args.errors?.length) {
    return `Your ticket plan had problems:
${bullet(args.errors)}

Reply again with the corrected complete plan as one fenced json block.`;
  }
  const feedback = args.feedback ? `\nThe user asked for these changes to the previous plan:\n<feedback>\n${args.feedback}\n</feedback>\n` : "";
  return `Plan the build for the project in .factory/spec/spec.md, following the
architecture in .factory/adr/0001-architecture.md.
Stack: ${args.profile.stack}
Gates: ${args.profile.gates.map((g) => `${g.name}: \`${g.command}\``).join("; ")}
${feedback}
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

export function ticketPrompt(ticket: Ticket, profile: Profile): string {
  return `Implement ticket ${ticket.id}: ${ticket.title}

${ticket.brief}

Requirements covered: ${ticket.requirements.join(", ") || "(none listed)"} — see docs/spec.md.
Acceptance criteria:
${bullet(ticket.acceptance)}

You may change only files matching: ${ticket.writeScope.join(", ")}
(lockfiles updated by the package manager are fine).

Before finishing, run these gates from the repository root and make them pass:
${profile.gates.map((g) => `- ${g.name}: \`${g.command}\``).join("\n")}

Write the tests for the acceptance criteria first, then the implementation.
Report what you changed and which tests cover each acceptance criterion.`;
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
