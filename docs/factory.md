# The software factory — a guide

How to use `/factory` day to day: starting runs, watching them, pausing and
resuming, reading cost reports and traces, and assigning models to roles. For
the quick start see the [README](../README.md); for the design and roadmap see
the [plan](software-factory-plan.md).

## What a run looks like

`/factory new <idea>` walks the project through eight phases, persisting to
`.factory/` between each step:

1. **discovery** — the analyst interviews you (at most 4 questions per round,
   each with a recommended answer and a "use your defaults" option; small
   ideas get one round), then the researcher adds notes if web research is on.
2. **spec** — the analyst writes `.factory/spec/spec.md` (FR/NFR IDs with
   Given/When/Then); you approve it or request changes.
3. **architecture** — the architect writes `.factory/adr/0001-architecture.md`
   and a stack profile (`.factory/profile.json`) with the gate commands
   (install, build, typecheck, lint, test), starting from the closest of the
   built-in stack templates (`node-ts-api`, `react-vite`, `python-fastapi`)
   rather than inventing commands. Significant standalone decisions (storage,
   auth, a new runtime dependency) get their own numbered ADR
   (`0002-<slug>.md`, …), and when the spec describes an API, UI or data
   surface the architect must also write machine-readable contracts under
   `.factory/contracts/` (`openapi.yaml` or a typed `api.ts`, `schema.sql`,
   shared types) as the source of truth for every interface — the factory
   verifies each listed contract and ADR file actually exists.
4. **planning** — the planner produces a dependency-ordered ticket list
   (`.factory/tickets.json`) whose graph must pass machine checks (every FR
   covered, dependencies acyclic, parallel tickets' write scopes disjoint),
   and a requirement → tickets matrix (`.factory/traceability.json`). See
   [Planning and traceability](#planning-and-traceability).
5. **skeleton** — a git worktree on branch `factory/<run>`, where the devops
   role builds a walking skeleton that must pass the gates.
6. **build** — tickets run in parallel where the plan allows (settled
   dependencies, disjoint write scopes, up to 3 at once), each in its own
   worktree and branch. A QA worker first writes failing acceptance tests,
   then the role's builder makes them pass; the factory (not the agent) runs
   the gates, reverts out-of-scope changes, scans for secrets, and a reviewer
   from a different model family approves. Approved tickets merge into the
   integration branch, where every gate runs again. Failures retry with
   feedback, then escalate up the role's model ladder, then ask you. See
   [The build loop](#the-build-loop).
7. **docs** — README, architecture notes, `AGENTS.md`, CHANGELOG.
8. **release** — final gates, merge into your branch when they pass (an
   optional deploy always asks first), and the report in
   `.factory/report.md`.

**Autonomy presets** decide how often the factory stops to ask you
(`/factory autonomy <preset>`, switchable at any time — even mid-run):

| Preset | You approve |
|---|---|
| `auto` | The spec. Everything else runs through to release. |
| `balanced` (default) | The spec, then one build-plan screen (stack, contracts, tickets, traceability, budget). |
| `careful` | Every gate: spec, architecture, build plan, each ticket commit, and the merge. |

In every preset the budget breaker and genuine blockers still stop and ask
you, and `/factory pause` works at any time.

## Planning and traceability

The architecture and the plan are data the factory verifies, not prose it
hopes is right.

**Contracts before code.** When the spec describes an API, UI or data
surface, the architect must write at least one machine-readable contract
under `.factory/contracts/` — an API spec (`openapi.yaml` or a typed
`api.ts`), a data schema (`schema.sql` or typed models), shared types — the
smallest set that pins every interface. The profile lists those files under
`contracts` (and its ADRs under `adrs`), and the factory rejects the
architect's reply if a listed file was not actually written (plain file names
only). The skeleton step copies the spec, every ADR and every contract into
the build worktree as `docs/spec.md`, `docs/adr/` and `docs/contracts/`, and
the planner is told to schedule foundation tickets that implement the
contracts first, so dependent tickets build against them instead of guessing
interfaces.

**The ticket graph.** The planner's reply is validated by the factory; every
error goes back to the planner (in the same session) until the plan passes:

- every functional requirement in the spec is covered by at least one ticket
  — `requirements not covered by any ticket: FR-004` is an error; an
  uncovered NFR is only a warning;
- dependencies point at earlier tickets that exist, are listed once, and form
  no cycle — `ticket dependency cycle: T-002 → T-003 → T-002` (or
  `T-003 depends on itself`) is an error;
- **parallel tickets never share a write scope.** Two tickets neither of
  which transitively depends on the other could run at the same time, so
  their `writeScope` globs must be disjoint — identical globs, a `**`
  catch-all, or one glob being a path prefix of the other (after stripping a
  trailing `/**`) all conflict: `T-004 and T-006 run in parallel but share
  write scope web/src/** (make scopes disjoint or add a dependency)` is an
  error that forces a re-plan. Disjoint scopes are what let independent
  tickets build in parallel, each worker certain no other ticket touches its
  files; tickets that must touch the same files are sequenced with a
  dependency instead;
- duplicate ticket ids, missing briefs or write scopes, and dependencies
  that do not exist or point at later tickets are errors; unknown roles,
  repeated dependency listings, tickets covering no requirement ids and
  plans over 40 tickets are warnings.

**The build-plan screen** (`balanced` and `careful`; skipped on `auto`) puts
the whole plan on one screen before any code is written — the stack, the
contract files, every gate with its exact command, the tickets in execution
order, a traceability line, the planner's warnings, the spend so far and
where the architecture lives:

```text
Stack: TypeScript 5 + Node 22 (Express) + Vitest
Contracts: .factory/contracts/openapi.yaml, .factory/contracts/schema.sql
Gates: install (`npm install`), build (`npm run build`), typecheck (`npx tsc --noEmit`), lint (`npx eslint .`), test (`npm test -- --run`)
4 tickets:
  T-001 habits REST API + SQLite schema [backend]
  T-002 habit board web UI [frontend]
  T-003 weekly streak view [frontend]
  T-004 README and API reference [docs]
traceability: 3/3 functional requirements covered
! T-004 covers no requirement ids
! non-functional requirements not covered by any ticket: NFR-002
Budget: $0.42/$5.00 spent so far.
Architecture: .factory/adr/0001-architecture.md
```

Approve it, *Change the tickets…*, or *Change the architecture…* (which
re-runs the architect and re-plans against the updated ADR).

**The traceability matrix.** Planning writes `.factory/traceability.json` —
one row per requirement in the spec (FRs first, then NFRs, in numeric
order), each listing the tickets that cover it, plus a `complete` flag that
is true when every functional requirement has a ticket:

```json
{
  "version": 1,
  "complete": true,
  "requirements": [
    {
      "requirement": "FR-001",
      "tickets": [
        "T-001"
      ]
    },
    {
      "requirement": "FR-002",
      "tickets": [
        "T-001",
        "T-002"
      ]
    },
    {
      "requirement": "FR-003",
      "tickets": [
        "T-003"
      ]
    },
    {
      "requirement": "NFR-001",
      "tickets": [
        "T-001"
      ]
    },
    {
      "requirement": "NFR-002",
      "tickets": []
    }
  ]
}
```

`complete` tracks functional requirements only — an NFR with no tickets
(the `NFR-002` row above) is the planner warning on the build-plan screen,
not a broken matrix.

## The build loop

Once the skeleton passes its gates, the build phase works through the ticket
graph with a scheduler instead of one ticket after another.

**Scheduling.** A ticket starts when every dependency is done (or skipped by
you) and its write scope overlaps no running ticket's scope, up to
`maxParallel` tickets at once (default 3). Tickets that both own a dependency
manifest (`package.json`, `pyproject.toml`, …) also share the lockfiles, so
they never run at the same time either — two parallel installs would
otherwise conflict in `package-lock.json`. In the to-do example, T-002 (API
handlers) and T-003 (web UI) both depend only on T-001 (the store) and have
disjoint scopes, so they build side by side as soon as T-001 merges.

**One worktree per ticket.** The skeleton's worktree on `factory/<run>` is
the *integration* branch. Each ticket gets its own worktree,
`.factory/worktrees/<run>-T-002`, on branch `factory/<run>-T-002`, branched
from the integration head when the ticket starts. Builders never see each
other's half-finished work; the ticket's change is exactly its diff against
the integration commit it last synced with.

**Per ticket:**

1. **QA first.** For backend and frontend tickets with acceptance criteria,
   the `qa` role writes tests for every criterion, limited to the test globs
   in the ticket's write scope (`test/**`, `tests/web/**`, `*.spec.ts`, …).
   The factory reverts anything QA writes outside them, runs the gates to
   confirm the new tests are red, and commits them on the ticket branch as
   `test(T-002): acceptance tests (QA)`. The builder's brief names those
   tests and tells it not to weaken them. Tickets without test globs, docs
   and devops tickets, and `build.qa: false` skip this step (the builder then
   writes the tests first itself, as before).
2. **Build.** The builder works in the ticket worktree. After each attempt
   the factory reverts out-of-scope files and runs the gates (install once
   per worktree, then again only when a manifest changed).
3. **Structured failures.** A failing gate's output is parsed before it goes
   back to the builder — failing test names (node:test, vitest, jest,
   pytest, go test, cargo test) and compiler/linter diagnostics (tsc,
   eslint, rustc, and any `file:line:col: error` style) come first, the raw
   log tail after:

   ```text
   Gate "test" failed (exit 1): `node --test`

   Failing tests (1):
   - lists todos as JSON

   Errors (1):
   - src/api/handlers.ts:12:5 TS2322 Type 'string' is not assignable to type 'Todo[]'.

   Output (tail):
   …
   ```

4. **Secret scan.** The ticket's diff is scanned for high-confidence
   credentials (private keys, AWS/GitHub/Anthropic/OpenAI/Slack/Stripe/Google/
   npm tokens, connection strings with passwords) and committed `.env`
   files. A hit goes back to the builder with redacted previews and the
   instruction to read the value from the environment instead; the change
   never reaches a commit.
5. **Review** by a model from a different family than the builders, as
   before — now against the ticket's whole diff including the QA tests.
6. **Integrate.** The approved change is committed on the ticket branch and
   merged into the integration branch (one merge at a time), and **every
   gate runs again on integration**. Then the ticket worktree and branch are
   removed.
   - **Conflict:** the merge is aborted, the integration branch is merged
     into the ticket branch instead, and the builder gets the conflicted
     files to resolve in its own worktree (conflicts in files outside the
     ticket's scope take the integration side automatically). Leftover
     `<<<<<<<` markers are caught before the gates run.
   - **Red integration:** the merge is undone, the integration branch is
     brought into the ticket branch so the failure reproduces there, and
     the builder gets the (structured) failure with a note that the change
     must work together with the integrated code.

**Escalation and breakers.** Every failed attempt (gates, secret, review,
conflict, integration) counts toward the role's ladder: two attempts per
model, then the next model up, then you choose to retry with the strongest
model, skip the ticket, or pause. Two breakers stop the loop and ask:

- the **budget breaker**, at 80% of the budget (raise it by 50% or pause);
- the **escalation breaker**, when more than 30% of the tickets needed a
  stronger model — usually a sign the tickets are too big or the briefs too
  vague. It asks once per run.

When one ticket stops the run (a pause, a blocker, the budget), the tickets
running alongside it are interrupted too; they keep their worktrees and
continue from them on `/factory resume`, and a blocked ticket is retried.

**Settings.** The loop's knobs are never asked during setup. Put them under
`build` in `~/.pi/agent/factory.json` (every project) or the folder's
`.factory/project.json` (this project wins):

```json
{
  "build": {
    "maxParallel": 3,
    "budgetBreaker": 0.8,
    "escalationBreaker": 0.3,
    "qa": true
  }
}
```

`maxParallel: 1` builds strictly one ticket at a time.

**History.** Every step lands in the ledger as a ticket event — started, QA
result, each attempt's outcome, scope reverts, review verdict, conflicts,
integration failures, merges, escalations, done/skipped/blocked — next to
the worker runs and gate runs (with their parsed failures). `/factory
history` lists every ticket's attempts and cost; `/factory history T-002`
replays one ticket:

```text
history of T-002 — $0.06 · 9.1k tok
10:02:11  started on factory/run-20261003-100000-T-002 from 3f2a9c1
10:02:11  qa · anthropic/claude-sonnet · 4 turn(s) · 2.1k tok · $0.01
10:02:19  gates (QA red check) FAILED: ✓ install (3.1s)  ✗ test (0.6s) — failing: lists todos as JSON
10:02:19  QA: red — test/api/handlers.test.js
10:02:20  backend · anthropic/claude-sonnet · 7 turn(s) · 4.0k tok · $0.03
10:02:31  gates passed: ✓ test (0.6s)
10:02:40  review: approve · openai/gpt-5
10:02:41  gates on integration passed: ✓ test (0.9s)
10:02:41  merged into integration 9be1d04 (3 files)
10:02:41  attempt 1: ok · anthropic/claude-sonnet
10:02:41  ✓ done after 1 attempt(s)
```

## Commands

| Command | Action |
|---|---|
| `/factory new [idea]` | Quick setup, then run the whole flow |
| `/factory status` | Where the run is: phase, tickets, spend, last stop |
| `/factory board` | The ticket board (the same lines as the live widget) |
| `/factory cost` | Spend by phase, role, model and ticket, with estimated savings vs an all-frontier team |
| `/factory trace [ticket\|role]` | Expandable trace of the last worker run (filtered by ticket or role) |
| `/factory history [ticket]` | Every ticket's attempts, outcomes and cost; with an id, that ticket's full history (QA, worker runs, gates with parsed failures, review, merges) |
| `/factory pause` | Pause after the current step |
| `/factory resume` | Continue the paused/interrupted run in this folder |
| `/factory doctor [probe]` | Check git, pi, models, team, pi-web-access, toolchains and deploy CLIs, with fixes; `probe` sends one tool call to each distinct team model |
| `/factory team [balanced\|cheap\|best\|refresh]` | Show the team, switch preset, or re-derive it from the models you are logged in to now |
| `/factory roles` | Assign a model to any role with the picker's Factory tab |
| `/factory autonomy auto\|balanced\|careful` | Switch at any time, even mid-run |
| `/factory settings` | Change the quick-setup answers for this folder |
| `/factory run <role> <brief>` | Run one role once, read-only (try a model, ask the architect) |
| `/factory demo` | Build a tiny to-do CLI in a temp folder on `auto` |
| `/factory help` (or bare `/factory`) | Menu when a run exists (resume, pause, status, doctor, new); otherwise prompts for an idea |

Tab completion covers subcommands, `autonomy`/`team` values, ticket ids and
role names for `trace`, and ticket ids for `history`.

## Resuming

Every phase transition, ticket status change and spend update is written to
the run lock, `.factory/factory.lock.json`, before the factory moves on. The
lock carries the phase, status, interview answers, tickets (with attempts and
commits), spend, the budget (including any raise you approved), the
branch/worktree pointers, and a **settings snapshot** of the run-scoped
answers (autonomy, project mode, stack, research, deploy).

**Reopening the project.** When you start pi in a folder with an unfinished
run, the footer shows `🏭 <phase> (interrupted)` (or the paused/failed/waiting
status) and pi offers a menu: *Resume the run now*, *Show status*, *Not
now*. `/factory resume` does the same on demand; `/factory pause` aborts
after the current step. Closing pi aborts an in-flight run cleanly — the
lock keeps whatever had persisted, and you resume from there.

**What resume keeps vs. re-derives.** The snapshot wins over today's
defaults, so a resumed run reproduces its own setup. The one thing resume
does *not* replay is the team: the preset and pins are deliberately not
snapshotted, so the team is rebuilt from the models you are logged in to
*now* — a role pinned with the picker keeps its pin.

**Fast paths and stop points.**

- A resumed **skeleton** phase checks whether the worktree already exists; if
  it does, the gates run first, and passing gates count as the skeleton done
  — no rebuild.
- The **budget breaker** fires at 80% of the dollar (or token) budget and
  asks: raise it by 50% or pause. A raised budget is written to the lock.
- A **blocked ticket** (every model on the role's escalation ladder tried)
  asks you: retry with the strongest model, skip the ticket, or pause.
- A failed worker or crash sets the run to `failed` with the error in the
  lock; fix the cause and `/factory resume`. Approval gates set the status to
  `waiting` until you answer.

**Archives and migration.** Starting `/factory new` while an unfinished run
exists asks for confirmation; the old lock then moves to
`.factory/runs/<runId>.json`, and a finished run is archived there the same
way when you start the next one. Locks from the earlier milestone named
`state.json` are migrated to `factory.lock.json` automatically on first load
(the old file is removed). A lock that is corrupt or missing its run id/idea
is treated as "no run here" rather than crashing.

## Watching a run

While a run is active you get three live views:

- **The board widget** above the footer, refreshed as workers report
  activity:

  ```text
  🏭 factory · build · 3/7 tickets · $1.24/$5.00
    ▶ T-004 backend — persist habits to SQLite (attempt 2)
    · T-007 todo — weekly streak view
    ✓ 3 done
    backend: edit src/db/habits.ts
    backend: $ npm test -- habits
  ```

  The header is `phase · done/total tickets · spend/budget` (with the status
  in parentheses when the run is not running). Up to four open tickets are
  listed — in progress first (`▶`, attempt count when > 1), then blocked
  (`✗`), then todo (`·`) — done/skipped collapse to a tally, and the last
  two worker activity lines trail. The widget disappears when the run ends.

- **The footer status line**: `🏭 build · 3/7 tickets · $1.24/$5.00`, or
  `waiting for your approval` at a gate.
- **Transcript entries** for phase changes, gate results, finished tickets,
  approvals and the final report — each collapsed to one line, expandable
  with pi's expand key.

`/factory status` prints the durable summary (works when nothing is running
too):

```text
run run-20260921-093000 · build · paused
idea: a habit tracker with a web UI and a REST API
spent: $1.24 of $5.00 · 412.3k tokens
tickets: 3/7 done
  ✓ T-001 repo and tooling
  … T-004 persist habits to SQLite
  · T-007 weekly streak view
branch: factory/run-20260921-093000
last stop: Factory paused. Run /factory resume to continue.
```

`/factory board` re-prints the board lines on demand.

## Cost and traces

Every worker run appends a line to `.factory/ledger.jsonl` — role, model,
ticket, phase, turns, tokens in/out, cost, and a bounded trace. Gate results
are logged too. `/factory cost` reports over that ledger, scoped to the
current (or last) run in the folder:

```text
cost for run run-20260921-093000
total $1.24 · 412.3k tokens · 19 worker run(s)
savings vs all-frontier: $2.10 (62.9%, estimate)
by phase:
  build: 10 run(s) · 240.5k tok · $0.73
  discovery: 4 run(s) · 58.9k tok · $0.20
  skeleton: 2 run(s) · 61.2k tok · $0.19
  spec: 2 run(s) · 33.4k tok · $0.08
  architecture: 1 run(s) · 18.3k tok · $0.04
by role:
  backend: 6 run(s) · 180.2k tok · $0.58
  analyst: 5 run(s) · 67.7k tok · $0.24
  devops: 2 run(s) · 61.2k tok · $0.19
  reviewer: 4 run(s) · 60.3k tok · $0.15
  researcher: 1 run(s) · 24.6k tok · $0.04
  architect: 1 run(s) · 18.3k tok · $0.04
by model:
  acme/era-2-flash: 14 run(s) · 327.4k tok · $1.05
  orion/sol-2: 5 run(s) · 84.9k tok · $0.19
by ticket:
  (no ticket): 9 run(s) · 171.8k tok · $0.51
  T-004: 5 run(s) · 142.8k tok · $0.44
  T-005: 5 run(s) · 97.7k tok · $0.29
```

Sections with fewer than two rows are omitted (ticket rows always show), rows
are sorted by cost, and long lists are capped with an `… and N more` line.
Worker runs from *other* runs in the same folder (and pre-M2 ledger lines
with no run id) are excluded and counted for you at the bottom.

**The savings line is an estimate.** Each worker's tokens are re-priced at
the current team's frontier model: input tokens at its input rate plus
output tokens at its output rate; when a ledger line has no in/out split,
its total tokens are priced at the model's blended rate. The savings are the
difference between that counterfactual "all-frontier team" cost and what the
mixed team actually cost. The line is omitted when the team has no model on
the frontier tier; a frontier model without known prices shows up as no
savings.

**Traces.** `/factory trace [ticket|role]` appends the latest worker run's
trace for that ticket or role (no argument: the latest traced worker run) as
an expandable entry — `role · model · ticket · time`, collapsed to "N trace
steps". Expanded, a trace shows the worker's thinking blocks, every tool
call with a described command or target, capped output excerpts, and errors:

```text
⋯ turn 4 thinking
  The habit test fails on the date boundary — the model stores UTC but…
• bash $ npm test -- habits
  3 passing
  1 failing
• edit src/habits/date.ts
✗ turn 6 aborted — stopped early
```

Traces are bounded (the last 80 steps, thinking truncated, outputs excerpted)
and ride along in the ledger, so they survive restarts. Worker entries in the
transcript expand the same way.

## Picking models per role

`/factory roles` opens the model picker on its **Factory tab**: the right
panel lists the roles (name and description) under `ASSIGN MODELS TO FACTORY
ROLES`. Pick a role with `↑`/`↓` and `Enter`, and the panel becomes the
normal model list titled `MODEL FOR THE <ROLE> ROLE` — search, effort picker
(`e`), badges and all. `Esc` backs out to the role list; `Esc` again leaves
the picker. Choosing a model pins it to that role. During quick setup, the
Team line's "pin any role" action opens the same picker focused on one role.

The pin is saved at user level (`~/.pi/agent/factory.json`, so it applies to
every project) and mirrored into `.factory/project.json` for this project
when one exists.

Pins, presets and role files combine like this:

- A **pin** (from the picker) wins outright for that role — the preset no
  longer affects it.
- Otherwise the role's **tier** maps through the preset: `balanced` uses each
  role's natural tier, `cheap` shifts one tier down (judgement roles never
  go below `daily`), `best` puts everything on `frontier`. `/factory team
  <preset>` switches; `refresh` re-derives the team from the models you are
  logged in to now.
- A role Markdown file (`~/.pi/agent/factory/roles/<role>.md`) can pin a
  model directly and override tier, effort, tools, escalation ladder or the
  whole prompt; later sources replace built-ins by name.
- A running build keeps its team; preset and pin changes apply to the next
  run or resume.

## What lands in `.factory/`

```text
.factory/
├── factory.lock.json    # the run lock: phase, status, tickets, spend, budget, settings snapshot
├── runs/<runId>.json    # archived runs, moved here when you start the next one
├── project.json         # this folder's quick-setup answers (pins mirrored here)
├── brief.md             # your idea, verbatim
├── spec/                # spec.md, decisions.md (interview), assumptions.md
├── research/            # notes.md from the researcher
├── adr/                 # 0001-architecture.md, then 0002-<slug>.md … per decision
├── contracts/           # openapi.yaml, schema.sql, shared types — interface source of truth
├── profile.json         # stack, gate commands, dependency manifests, contract/ADR lists
├── tickets.json         # the plan, dependency-ordered
├── traceability.json    # requirement → tickets matrix, written at planning
├── reviews/             # reviewer verdicts per ticket attempt
├── report.md            # final report: tickets, cost by role, notes
├── ledger.jsonl         # append-only log: worker runs (usage, cost, traces), gates, ticket events
├── sessions/            # worker pi sessions               — git-ignored
├── worktrees/           # integration + per-ticket worktrees — git-ignored
└── .gitignore           # written by the factory: sessions/, worktrees/, *.tmp
```

Everything except `sessions/`, `worktrees/` and `*.tmp` is meant to be
committed with your project — spec, contracts, tickets, reviews, ledger and
report are part of the run's history. Remembered *answers* live outside the repo:
team preset, pins, autonomy and research in `~/.pi/agent/factory.json` (every
project), the rest per folder in `project.json`.

## Guard rails

Workers are real `pi` subprocesses with their own sessions, and every tool
call they make passes the factory's guard:

- **Write scopes.** `edit`/`write` outside the ticket's write scope are
  blocked (an empty scope means read-only — researcher, reviewer, planner
  and `/factory run` never write). Scopes are relative to the worker's
  working directory (the worktree during build), so nothing outside it is
  writable, and `.git/` is never writable. If a change slips through anyway,
  the harness diffs the worktree after every attempt and reverts anything
  out of scope before the gates run.
- **Blocked commands.** `git push`/`commit`, history rewrites and branch
  operations the factory owns (`merge`, `rebase`, `switch`, `stash`,
  `cherry-pick`, …), `sudo`, package publishing, recursive deletes outside
  the worktree (including absolute paths), writing to block devices,
  reading credential stores (`~/.ssh`, `~/.aws`, `~/.npmrc`, …), fork bombs,
  piping remote scripts into a shell, and deploy CLIs (`fly deploy`,
  `vercel --prod`, `netlify deploy`, `wrangler deploy`, `railway up`,
  `kubectl apply`, `terraform apply`, `docker push`, …) — deploy commands
  unlock only for the one deploy worker, after you approved the deploy.
- **Gates are run by the factory** (`install`/`build`/`typecheck`/`lint`/
  `test` from the stack profile), never claimed by an agent; "done" requires
  passing gates plus a reviewer approval.
- **Secrets.** The factory stores nothing: deploy CLIs reuse their own
  logins, and the deploy worker writes `.env.example` — never your `.env`.
  A secret scan runs on every ticket's diff before it can merge, and on
  the whole factory branch before release; a finding at release keeps the
  build on the factory branch and is listed in the report.
- **The merge is yours.** Release merges only when the final gates pass, the
  secret scan is clean, you are on the branch you started on, and your tree
  is clean (in `careful`, only after you approve).

See the [plan's safety section](software-factory-plan.md#15-safety-cost-and-failure-handling)
for the design, and the [README](../README.md) for the quick start.
