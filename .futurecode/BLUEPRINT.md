# Project Blueprint
# Generated: 2026-02-20
# This file is read by coding agents BEFORE they write any code.
# It is the source of truth for project structure, constraints, and decisions.

## What This Project Is

**Name**: pair-programming-assistant
**Purpose**: [FILL IN -- describe what this project does]
**Stage**: [FILL IN -- prototype/active development/production/maintenance]
**Primary language**: Unknown

---

## Frozen Decisions

These decisions have already been made. Do NOT change them without explicit human approval.
Changing any of these requires a conversation, not a commit.

_Scan found no DECISION:HARD_TO_REVERSE markers. Document existing architectural decisions._

---

## Architecture Constraints

_[FILL IN -- scan cannot infer architecture intent. Describe your structural rules.]_

---

## Module Boundaries

These are the boundaries between modules. Respect them.
A module can only talk to another module through its public interface.

_No high-coupling modules detected._

---

## Assumptions In Effect

These are the current operating assumptions. Each has an expiry condition.
When the condition is met, flag it -- don't silently keep building on an expired assumption.

_No undeclared assumptions detected._

---

## Code Standards

When writing code in this project, ALWAYS follow these rules:

### Structure
- Every module exposes an interface, never its implementation.
- No circular imports. If you create one, stop and restructure.
- No module-level mutable state unless explicitly approved in Frozen Decisions.
- No function longer than 60 lines or with cyclomatic complexity above 15.

### Assumptions
- Every hardcoded value (timeout, limit, threshold, URL, port) MUST have:
  ```
  # ASSUMPTION: [what]=[value] -- [why this value].
  #   VALID_UNTIL: [when to reassess].
  #   RISK_IF_WRONG: [what breaks].
  ```
- Every external service call MUST have:
  ```
  # EXTERNAL_ASSUMPTION: [service] -- [expected behavior].
  #   FALLBACK: [what happens if it fails].
  #   MONITOR: [how to detect problems].
  ```

### Decisions
- If you are about to make a choice that would take more than a day to undo, STOP.
  Ask the human. Mark it with:
  ```
  # DECISION:HARD_TO_REVERSE
  # what: [description]
  # why: [rationale]
  # alternatives_considered: [what else was evaluated]
  # reversal_cost: [effort to change later]
  # reassess_when: [condition to revisit]
  ```

### Before You Write
- Read this file completely before generating any code.
- If your task conflicts with anything in this blueprint, say so. Don't silently override.
- If you're unsure whether something is allowed, ask. Don't guess.

---

## What NOT To Do

_No critical anti-patterns detected._

---

## Active TODOs and Known Gaps

- [ ] Complete this blueprint with project-specific details
- [ ] Document all frozen decisions
- [ ] Define module boundaries
- [ ] Review 12 findings from initial scan

---

## How to Update This Blueprint

This file is maintained by humans, not by agents. If an agent discovers that
something in this blueprint is outdated or wrong, it should flag it in its
response -- not modify this file directly.

To update: edit `.futurecode/BLUEPRINT.md` and commit the changes.
