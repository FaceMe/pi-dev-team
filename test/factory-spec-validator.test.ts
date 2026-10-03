import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/factory/spec-validator.js";
import type { SpecValidation } from "../src/factory/spec-validator.js";

const VALID_SPEC = `# Task tracker

## Overview
A small task tracker for a team of five.

## User stories
- As a team lead, I want to assign tasks, so that work is visible.

## Functional requirements

### FR-001: Create tasks
- **Given** a logged-in user
- **When** they submit the new-task form with a title
- **Then** the task appears in the backlog

### FR-002: Complete tasks
Given a task that is assigned to me
When I mark it done
Then it moves to the done column and the assignee is notified

### FR-003: Filter board
- **Given** the board shows 20 tasks
  - **When** I filter by assignee me
  - **Then** only my tasks remain

## Non-functional requirements

### NFR-001: Response time
The board API returns p95 < 300 ms at 50 rps.

### NFR-002: Capacity
The system must support at least 100 concurrent users.

## Out of scope
- Calendar integration

## Traceability
| Requirement | Source |
| --- | --- |
| FR-001 | brief |
| FR-002 | q2 |
| FR-003 | assumption: email is enabled |
| NFR-001 | interview |
| NFR-002 | brief |
`;

const MISSING_GWT = `# Spec

## Functional requirements
### FR-001: Create tasks
- Given a logged-in user, When they submit the form, Then the task appears

### FR-002: Complete tasks
The task moves to the done column and the assignee gets a notification.

### FR-003: Filter board
Given the board has tasks
When the user filters by assignee
Then only that assignee's tasks stay visible

## Non-functional requirements
### NFR-001: Speed
p95 < 300 ms at 50 rps.

## Traceability
- FR-001 — brief; FR-002 — q1; FR-003 — brief
`;

const UNMEASURABLE_NFR = `# Spec

## Functional requirements
### FR-001: Create tasks
- Given a logged-in user, When they submit the form, Then the task appears

## Non-functional requirements
### NFR-001: Response time
p95 < 300 ms at 50 rps.

### NFR-002: Performance
The system should be fast and responsive.

## Traceability
- FR-001 — brief
- NFR-001, NFR-002 — interview
`;

const NO_TRACE_SECTION = `# Notes app

## Functional requirements
### FR-001: Create a note
- Given a signed-in user, When they save a note, Then it is stored

## Non-functional requirements
### NFR-001: Capacity
At least 50 concurrent users.
`;

const MARKERS_INSTEAD_OF_SECTION = `# Notes app

## Functional requirements
### FR-001: Create a note (answers q1)
- Given a signed-in user, When they save a note, Then it is stored

### FR-002: Delete a note (assumption: soft deletes)
- Given an existing note, When its owner deletes it, Then it leaves the list

## Non-functional requirements
### NFR-001: Capacity
At least 50 concurrent users.
`;

const TRACE_SECTION_WITHOUT_IDS = `# Notes app

## Functional requirements
### FR-001: Create a note
- Given a signed-in user, When they save a note, Then it is stored

## Non-functional requirements
### NFR-001: Capacity
At least 50 concurrent users.

## Traceability
Every requirement above comes from the original brief text.
`;

const DUPLICATE_ID = `# Spec

## Functional requirements
### FR-001: Login
- Given a registered user, When they submit credentials, Then they are signed in
### FR-001: Logout
- Given a signed-in user, When they open the menu, Then a sign-out action is visible

## Non-functional requirements
### NFR-001: Speed
p99 under 200 ms.

## Traceability
- FR-001 — brief
`;

const PROSE_MENTION = `# Spec

## Functional requirements
### FR-001: Create tasks
- Given a user, When they add a task, Then it is listed

### FR-002: Label tasks
Extends FR-001 with colours.
- Given a task, When the user picks a colour, Then the label is applied

## Non-functional requirements
### NFR-001: Speed
Under 2 seconds for the board to render.

## Traceability
- FR-001, FR-002 — interview answers
`;

const LIST_ITEM_FORM = `# Export tool

## Functional requirements
- **FR-010** — Export tasks as CSV (answers q1)
  - given a board with tasks, when the user clicks Export, then a CSV downloads
- **FR-011** — Search tasks (from the brief)
  - Acceptance: Given text in the search box, When the user presses enter, Then the list filters

## Non-functional requirements
- **NFR-001** — Exports finish within 2 seconds for 10k tasks
`;

const SHARED_CRITERIA = `# Sign-in

## Functional requirements
- **FR-020** — Sign in with password
- **FR-021** — Sign in with SSO
- Acceptance (covers both): Given a registered user, When they sign in with either method, Then they reach the dashboard

## Non-functional requirements
### NFR-001: Sign-in latency
p95 under 400 ms.

## Traceability
- FR-020, FR-021 — from the brief
`;

const INLINE_ONLY_IDS = `Spec: the app must support login (FR-001, answers q1) and export (FR-002, from the brief).
(FR-001) Given a registered user, When they sign in, Then they reach the board
(FR-002) Given a board with tasks, When the user chooses export, Then a CSV downloads
`;

const LOWERCASE_INLINE = `# Spec

## Functional requirements
### FR-030: Undo — given an edit exists, when the user presses undo, then the change reverts

## Non-functional requirements
### NFR-001: Durability
Backups retained for 30 days.

## Traceability
- FR-030 — brief
`;

const ID_ONLY_NFR = `# Spec

## Functional requirements
### FR-001: Ping
- Given the service is up, When the client pings, Then it gets a pong

## Non-functional requirements
### NFR-003

## Traceability
- FR-001 — brief
`;

const issuesFor = (v: SpecValidation, id: string) => v.issues.filter((i) => i.requirement === id || i.message.includes(id));

describe("validateSpec", () => {
  it("accepts a complete heading-form spec with traceability table", () => {
    const v = validateSpec(VALID_SPEC);
    expect(v.ok).toBe(true);
    expect(v.frs).toEqual(["FR-001", "FR-002", "FR-003"]);
    expect(v.nfrs).toEqual(["NFR-001", "NFR-002"]);
    expect(v.issues).toEqual([]);
    expect(v.summary).toBe("3 functional, 2 non-functional requirements, no issues");
  });

  it("accepts list-item form with lowercase and inline Acceptance criteria", () => {
    const v = validateSpec(LIST_ITEM_FORM);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.frs).toEqual(["FR-010", "FR-011"]);
    expect(v.nfrs).toEqual(["NFR-001"]);
  });

  it("accepts several FRs covered by one shared criteria block", () => {
    const v = validateSpec(SHARED_CRITERIA);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.frs).toEqual(["FR-020", "FR-021"]);
  });

  it("accepts a case-insensitive triple written on the requirement line", () => {
    const v = validateSpec(LOWERCASE_INLINE);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it("falls back to every occurrence when no id heads a line", () => {
    const v = validateSpec(INLINE_ONLY_IDS);
    expect(v.ok).toBe(true);
    expect(v.frs).toEqual(["FR-001", "FR-002"]);
  });

  it("flags an FR without a Given/When/Then criterion", () => {
    const v = validateSpec(MISSING_GWT);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].requirement).toBe("FR-002");
    expect(v.issues[0].message).toContain("FR-002");
    expect(v.issues[0].message).toContain("Given/When/Then");
  });

  it("flags an unmeasurable NFR", () => {
    const v = validateSpec(UNMEASURABLE_NFR);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].requirement).toBe("NFR-002");
    expect(v.issues[0].message).toBe("NFR-002 is not measurable (no numeric threshold)");
  });

  it("flags an NFR whose id has no requirement text at all", () => {
    const v = validateSpec(ID_ONLY_NFR);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(issuesFor(v, "NFR-003")).toHaveLength(1);
    expect(v.issues[0].message).toContain("NFR-003");
  });

  it("asks for traceability when there is no section and no source markers", () => {
    const v = validateSpec(NO_TRACE_SECTION);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].message).toBe(
      "no traceability section: map each FR to an interview answer, a stated assumption or the brief",
    );
  });

  it("accepts per-requirement source markers instead of a traceability section", () => {
    const v = validateSpec(MARKERS_INSTEAD_OF_SECTION);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it("does not count a traceability section that references no requirement ids", () => {
    const v = validateSpec(TRACE_SECTION_WITHOUT_IDS);
    expect(v.ok).toBe(false);
    expect(v.issues.filter((i) => i.message.includes("no traceability section"))).toHaveLength(1);
  });

  it("flags a duplicated requirement id once", () => {
    const v = validateSpec(DUPLICATE_ID);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].message).toBe("duplicate requirement id FR-001");
    expect(v.frs).toEqual(["FR-001"]);
    expect(v.summary).toBe("1 functional, 1 non-functional requirements, 1 issue");
  });

  it("treats a prose mention of another id as a reference, not a duplicate", () => {
    const v = validateSpec(PROSE_MENTION);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.frs).toEqual(["FR-001", "FR-002"]);
  });

  it("rejects an empty spec with a clear issue", () => {
    for (const text of ["", "   \n\t  \n"]) {
      const v = validateSpec(text);
      expect(v.ok).toBe(false);
      expect(v.frs).toEqual([]);
      expect(v.nfrs).toEqual([]);
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0].message).toContain("empty");
    }
  });

  it("flags a spec with no functional requirements", () => {
    const v = validateSpec("# Notes\n\nSome prose about the product, with no requirement ids.\n");
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(1);
    expect(v.issues[0].message).toBe("no functional requirements (FR-xxx) found");
  });
});
