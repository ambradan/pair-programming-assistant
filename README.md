# Pair Programming Assistant (PPA)

AI-powered coding assistant with two modes: single-request code suggestions (Normal) and autonomous multi-step execution (Ralph).

---

## What it does

### Normal mode

1. Type a request: *"refactora il booking service per usare dependency injection"*
2. PPA indexes your codebase, finds the relevant files and symbols
3. Calls the LLM with your code as context
4. Returns:
   - Exact code changes with line numbers
   - Split diff view: original → proposed
   - Technical and plain-language explanation (Italian + English)
   - Alternative approaches considered and why they were rejected
   - Navigation through all affected files (← → or arrow keys)
5. Apply individual changes or all at once; revert from `.bak` backups

### Ralph mode

Ralph breaks a natural-language goal into a checklist of tasks, then works through them one by one — pausing after each for your review.

1. Type what you want built: *"Add JWT auth with rate limiting to the API"*
2. Click **Decompose** — Ralph uses the power LLM tier to generate an ordered task list
3. Edit, reorder, or remove tasks before running
4. Click **Run** — Ralph iterates:
   - Calls the LLM for the current task using your live codebase as context
   - Shows the proposed changes in the same diff viewer as Normal mode
   - Pauses and asks: **Accept / Retry / Skip / Stop**
   - On accept: applies changes, optionally commits with a Conventional Commits message
   - Marks the task complete and moves to the next
5. Toggle **Auto-pilot** to skip review and accept all changes automatically

---

## Architecture

```
Browser
  ├── Normal mode  ──POST /api/assist──────────────────────┐
  └── Ralph mode   ──POST /api/loop/decompose              │
                   ──POST /api/loop/start                  │
                   ──GET  /api/loop/events/:id  (SSE)      │
                   ──POST /api/loop/decide/:id             │
                                                           ▼
                                              Fastify backend (port 3001)
                                                ├── Project Indexer
                                                │     ├── project-indexer.ts  (AST + regex)
                                                │     └── project-map.ts      (compressed summary)
                                                ├── LLM Provider
                                                │     ├── Anthropic (claude-sonnet / claude-opus)
                                                │     ├── Nebius    (Kimi-K2.5, OpenAI-compatible)
                                                │     └── Gemini    (gemini-2.0-flash)
                                                ├── Assist Service
                                                │     └── XML-structured prompts → parsed code changes
                                                └── Ralph Loop
                                                      ├── runner.ts        (async generator, human-in-the-loop)
                                                      ├── prd.ts           (markdown checkbox parser)
                                                      └── commit-manager.ts (LLM Conventional Commits)
```

The backend does all the work. The UI is a thin SSE client.

---

## Quick start

```bash
npm install
cp .env.example .env
# Add at least one API key (see Configuration below)
npm run dev
# Open http://localhost:3001
```

---

## Configuration

All configuration is via environment variables (`.env` or shell).

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | One of these | Direct Anthropic API key (`sk-ant-api03-…`) |
| `NEBIUS_API_KEY` | One of these | Nebius AI Studio key (OpenAI-compatible endpoint) |
| `GEMINI_API_KEY` | One of these | Google Gemini API key |
| `PPA_PORT` | No | HTTP port (default: `3001`) |
| `NODE_ENV` | No | `development` for pretty logs |

At least one LLM key is required. Multiple keys can be set — PPA uses the first available and falls back through the chain (`anthropic → nebius → gemini`) if a backend fails.

---

## LLM backends and model tiers

PPA uses two abstract tiers rather than hardcoded model names:

| Tier | Purpose | Anthropic | Nebius | Gemini |
|---|---|---|---|---|
| `fast` | Default — low latency, most requests | claude-sonnet-4-5 | Kimi-K2.5 | gemini-2.0-flash |
| `power` | Complex requests, decomposition | claude-opus-4-6 | Kimi-K2.5 | gemini-2.0-flash |

The ⚡ **Power** button in Normal mode forces the power tier. Ralph always uses power for decomposition and fast for iteration (configurable).

Token costs are tracked per iteration using published pricing and exposed in the Ralph status bar.

---

## Source tree

```
src/
  server.ts                 Entry point
  app.ts                    Fastify setup, route registration
  llm/
    provider.ts             Multi-backend LLM abstraction (Anthropic, Nebius, Gemini)
  indexer/
    project-indexer.ts      AST + regex codebase indexer, symbol search
    project-map.ts          Compressed project summary for LLM context
  services/
    assist.service.ts       Core assist logic: search → context → LLM → parse
    git-clone.service.ts    Clone remote repos to a temp directory
  routes/
    assist.routes.ts        /api/assist, /api/index, /api/search, /api/apply, /api/revert, /api/clone, /api/status
    loop.routes.ts          /api/loop/* (decompose, start, events SSE, status, decide, cancel, sessions)
  loop/
    runner.ts               Ralph async generator loop engine + decompose()
    prd.ts                  Markdown checkbox parser, task state, PRD validation
    commit-manager.ts       LLM-generated Conventional Commits, async git operations
web/
  public/
    index.html              Single-page UI (Normal + Ralph modes)
```

---

## API reference

### Assist (Normal mode)

```
POST /api/assist
  Body: { message: string, projectPath: string, forceModel?: "fast" | "power" }
  Returns: AssistResponse (intent, changes[], reasoning, model, latencyMs, tokensUsed)

POST /api/apply
  Body: { projectPath: string, changes: Change[] }
  Returns: { results: [{ file, status, backup? }] }

POST /api/revert
  Body: { projectPath: string, file: string }
  Restores file from its .bak backup

POST /api/index
  Body: { projectPath: string }
  Force re-index; returns file/symbol/dependency counts

POST /api/search
  Body: { projectPath: string, query: string }
  Returns ranked symbol matches

POST /api/clone
  Body: { gitUrl: string }
  Clones repo to a temp dir; returns localPath

GET  /api/status
  Returns server health, configured providers, indexed projects
```

### Ralph (Loop mode)

```
POST /api/loop/decompose
  Body: { message: string, projectPath: string }
  Returns: { prdContent, tasks[], warnings[] }
  Uses the power tier to break the request into an ordered task checklist.

POST /api/loop/start
  Body: { prdContent, projectPath, maxIterations?, autoApply?, autoCommit?,
          autoPilot?, failFast?, maxCost?, forceModel? }
  Returns: { sessionId, eventsUrl, taskCount, validationWarnings[] }
  Starts the loop as a detached async process.

GET  /api/loop/events/:id                        (text/event-stream)
  SSE stream of loop events. Late-joining clients receive a replay of all
  prior events before live streaming begins.

  Event types:
    iteration:start   { iteration, task }
    iteration:paused  { iteration, task, result: AssistResponse }
    iteration:end     { iteration, task, decision, success, appliedFiles, durationMs, costUsd }
    task:blocked      { iteration, task, reason }
    commit:done       { iteration, hash, message }
    commit:failed     { iteration, error }
    cost:update       { iterationCost, totalCost }
    loop:end          { reason: "complete"|"stopped"|"max_iterations"|"cost_limit"|"cancelled"|"failed" }

GET  /api/loop/status/:id
  Returns session snapshot: status, tasks[], iterations[], totalCost, prdContent

POST /api/loop/decide/:id
  Body: { decision: "accept" | "retry" | "skip" | "stop" }
  Unblocks a paused loop. Must be called while session status is "paused".

POST /api/loop/cancel/:id
  Force-cancels a running or paused session.

GET  /api/loop/sessions
  Lists all active sessions with summary stats.
```

---

## Ralph: human-in-the-loop flow

```
User prompt
    │
    ▼
POST /decompose  ──[power LLM]──▶  task checklist
    │
    ▼
User edits tasks (add / remove / rename)
    │
    ▼
POST /start
    │
    ▼
for each task:
    ├── LLM generates code changes (AssistResponse)
    │
    ├─── autoPilot=true ──▶ apply + optionally commit + next task
    │
    └─── autoPilot=false ──▶ SSE: iteration:paused
                                  UI loads diff viewer
                                  User sees Accept / Retry / Skip / Stop
                                  │
                                  ├── Accept ──▶ apply changes
                                  │             mark task [x]
                                  │             optionally commit (Conventional Commits via LLM)
                                  │             next task
                                  ├── Retry  ──▶ re-run same task
                                  ├── Skip   ──▶ mark task [x], move on without applying
                                  └── Stop   ──▶ end loop
```

---

## Commit messages

When `autoCommit` is enabled, Ralph generates commit messages using the LLM (fast tier) following [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(auth): add JWT validation middleware

Replaces session-based auth with stateless JWT tokens.
Rate limiting applied per IP using sliding window algorithm.
```

The commit message is generated from the task description, the files changed, and a summary of the LLM's reasoning. If generation fails, the loop falls back to a plain `feat: <task text>` message.

---

## Development

```bash
npm run dev          # tsx watch — hot reload
npm run build        # tsc — type check + compile
npm run typecheck    # tsc --noEmit — type check only
npm test             # vitest run
npm run test:watch   # vitest watch
```

Changes to `web/public/index.html` take effect immediately (static files, no build step).

---

## Project index cache

PPA indexes each project on first request and caches the result for 5 minutes. The index includes:

- All source files (excluding `node_modules`, `.git`, `dist`, build artifacts)
- AST-parsed symbols: functions, classes, interfaces, type aliases, exports
- Import/dependency graph
- A compressed project map summarising every file in ~10 tokens

The watcher automatically updates the index when files change. Force a full re-index with the **Re-index** button or `POST /api/index`.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+Enter` | Send request (Normal mode) |
| `Ctrl+Enter` | Decompose prompt (Ralph mode, when prompt is focused) |
| `←` / `↑` | Previous change |
| `→` / `↓` | Next change |
