# Project Rules

## Project Memory

### Active Decisions — DO NOT CHANGE without human approval
Generated: 2026-02-20 11:02 UTC
Decisions: 3 active | Rejections: 0 | Entities: 32 tracked

## Active Decisions
- **Environment variables for config** — [auto-inferred] Found .env in project
- **Node.js runtime** — [auto-inferred] Found package.json in project
- **TypeScript as language** — [auto-inferred] Found tsconfig.json in project

## Entity Graph
- dependency: 12
- function: 10
- module: 7
- class: 2
- package: 1

## Hard Rules

- NEVER use `as any` in TypeScript. Use `as unknown` + type guard.
- NEVER use blanket `# type: ignore`. Use `# type: ignore[specific-code]`.
- NEVER use `@ts-ignore`. Use `@ts-expect-error` with comment.
- NEVER use bare `except:` in Python. Use specific exception types.
- NEVER use `eval()` or `exec()` in production code.
- NEVER build SQL with string concatenation. Use parameterized queries.
- NEVER swallow errors silently (empty catch, `except Exception: pass`).
- NEVER make a hard-to-reverse decision (DB, auth, infra) without asking first.

## Decision Protocol

After every architectural decision, run:
```bash
futurecode remember decision "<what>" --why "<why>"
```
When rejecting an alternative:
```bash
futurecode remember rejection "<what>" --why "<why>"
```
Before committing:
```bash
futurecode guard .
```

## Assumptions

Every hardcoded value needs a comment:
```
# ASSUMPTION: timeout=30 — p99 latency under normal load.
#   VALID_UNTIL: traffic exceeds 10k rps.
#   RISK_IF_WRONG: request timeouts in checkout flow.
```
