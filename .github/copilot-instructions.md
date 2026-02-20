# Copilot Instructions

## Project Memory
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

## Rules
- No `as any`, bare `except:`, `eval()`, `exec()`, SQL concatenation
- No blanket `# type: ignore` — use specific codes
- No empty catch blocks — log errors at minimum
- No hard-to-reverse decisions without asking
- Document hardcoded values with ASSUMPTION comments
- No circular imports, no module-level mutable state
