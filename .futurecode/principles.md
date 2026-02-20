# Futurecode Design Principles

## Purpose
These principles ensure that code written today remains safe to change tomorrow.
They apply to any agent — human, LLM, or hybrid — producing code in any project.

---

## Principle 1: Isolation by Default

Every module, class, or component MUST expose an interface, never its implementation.

**Rules:**
- No module imports internal functions/classes from another module's implementation files.
- Shared state between modules is prohibited unless mediated by an explicit contract (interface, protocol, event bus).
- Each module has a single public surface: `__init__.py` exports, API schema, or equivalent.
- Circular imports are a structural failure, not a style issue.

**Test:** Can you delete the internals of module X and rewrite them without changing any other file? If no → isolation is broken.

---

## Principle 2: Declare Your Assumptions

Every assumption embedded in code MUST be explicit and locatable.

**Rules:**
- Hardcoded values that represent business logic, thresholds, limits, or environmental expectations must be in a dedicated config layer, not inline.
- When a value IS inline, it requires a structured comment:
  ```
  # ASSUMPTION: max_items=1000 — based on current avg load of 200 items/request.
  #   VALID_UNTIL: reassess if avg load exceeds 500 or user count exceeds 10k.
  #   RISK_IF_WRONG: OOM on worker nodes, degraded response time.
  ```
- External dependencies (APIs, services, libraries) must declare their assumed behavior:
  ```
  # EXTERNAL_ASSUMPTION: Stripe API responds < 2s at p99.
  #   FALLBACK: timeout + retry with exponential backoff.
  #   MONITOR: alert if p99 > 1.5s for 5min window.
  ```

**Test:** Can a new developer (or LLM) find every assumption in this codebase by searching for `ASSUMPTION:` and `EXTERNAL_ASSUMPTION:`? If no → assumptions are hidden.

---

## Principle 3: Measure Reversibility Before Committing

Every architectural decision has a reversal cost. High-cost decisions require explicit approval.

**Classification:**
- **EASY_TO_REVERSE**: Adding a new endpoint, creating a utility function, adding a config parameter. Cost to undo: minutes to hours.
- **MEDIUM_TO_REVERSE**: Changing a database schema with migration, adopting a new library for a core function, modifying a public API contract. Cost to undo: hours to days.
- **HARD_TO_REVERSE**: Choosing a database engine, defining the auth model, selecting a message broker, designing the data model for a core entity. Cost to undo: days to weeks+.

**Rules:**
- `HARD_TO_REVERSE` decisions MUST be documented with:
  ```
  # DECISION:HARD_TO_REVERSE
  # what: Using PostgreSQL with JSONB for event storage
  # why: Need both relational queries and flexible schema for event payloads
  # alternatives_considered: MongoDB (rejected: operational complexity), 
  #   DynamoDB (rejected: vendor lock-in), pure relational (rejected: schema rigidity)
  # reversal_cost: 2-3 weeks migration + data transformation
  # reassess_when: event volume > 10M/day OR query patterns shift to primarily document-based
  ```
- `MEDIUM_TO_REVERSE` decisions SHOULD be documented with at minimum the `what` and `why`.
- Code reviews / PR approvals MUST flag any `HARD_TO_REVERSE` decision that lacks documentation.

**Test:** Can you list every hard-to-reverse decision in this project in under 5 minutes? If no → you have invisible technical debt.

---

## Principle 4: Design for Removal, Not Just Addition

Code should be easy to delete. A module that is hard to remove is a liability.

**Rules:**
- Feature flags for anything experimental or uncertain. If the feature fails, you flip a flag, not rewrite a module.
- Prefer composition over inheritance. Inheritance creates removal-resistant coupling.
- No "god modules" — if a file is imported by more than N other files (project-dependent threshold, default 8), it must be split or abstracted behind an interface.
- Dead code is not "just in case" code. It's invisible coupling that confuses agents and humans. Remove it.

**Test:** Can you remove feature X from the codebase in under 1 hour without breaking anything else? If no → feature X is not properly isolated.

---

## Principle 5: Temporal Coupling is Hidden Coupling

Code that must execute in a specific order without that order being enforced by structure is fragile.

**Rules:**
- If function B depends on function A having run first, this must be enforced structurally (pipeline, state machine, dependency injection), not by convention or comments.
- Initialization sequences must be explicit, not scattered across module-level side effects.
- If ordering matters, model it as data (a DAG, a pipeline definition), not as implicit call order.

**Test:** If you reorder the imports or function calls, does the system break silently (no error, wrong behavior)? If yes → temporal coupling exists.

---

## Principle 6: Future-Proof ≠ Over-Engineer

These principles prevent fragility. They do NOT require predicting the future.

**Anti-patterns to avoid:**
- Building abstractions for hypothetical use cases that don't exist yet.
- Creating plugin systems when you have one plugin.
- Designing for "millions of users" when you have 50.

**The rule:** Solve today's problem with tomorrow's changeability. Don't solve tomorrow's problem today.

---

## How to Use These Principles

### As System Prompt (for LLM agents)
Inject the content of this file into the system prompt of any coding agent.
Add: "Before producing code, verify it satisfies all 6 Futurecode principles.
Flag any violations in your response."

### As Code Review Checklist
For each PR, verify:
- [ ] No isolation violations (Principle 1)
- [ ] All assumptions declared (Principle 2)
- [ ] Hard-to-reverse decisions documented (Principle 3)
- [ ] No god modules created or worsened (Principle 4)
- [ ] No temporal coupling introduced (Principle 5)
- [ ] No speculative over-engineering (Principle 6)

### As Onboarding Guide
New team members read this before writing their first line of code.
