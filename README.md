# Pair Programming Assistant (PPA)

AI-powered tool that listens to pair programming requests and provides precise, navigable code suggestions with explanations.

## What it does

1. You type (or speak) a request: "refactora il booking service per usare dependency injection"
2. PPA indexes your codebase, finds the relevant files and symbols
3. Calls Claude (Sonnet for fast responses, Opus for complex ones) with your code as context
4. Returns:
   - Exact code changes with line numbers
   - Split view: original → proposed
   - Technical explanation + plain language explanation
   - Alternative approaches considered (and why rejected)
   - Navigation through all affected files (← →)

## Architecture

```
Web UI (browser) ──HTTP──▶ Backend (Fastify, port 3001)
                              ├── Project Indexer (AST + regex)
                              ├── LLM Provider (Anthropic + Gemini fallback)
                              └── Assist Service (intent → code changes)
```

The backend does the heavy lifting. The UI is a thin client.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env → add your ANTHROPIC_API_KEY
npm run dev
# Open http://localhost:3001
```

## Usage

1. Set your project path in the bottom-left input
2. Click "Re-index" to scan the project
3. Type your request and press Ctrl+Enter
4. Navigate changes with arrow keys or ← → buttons
5. Use the ⚡ Opus button for complex requests

## API

```
POST /api/assist   — Main endpoint (message + projectPath → code changes)
POST /api/index    — Force re-index a project
POST /api/search   — Search symbols in indexed project
GET  /api/status   — Health check
```

## Model Selection

- **Sonnet** (default): Fast (~3s), good for most requests
- **Opus** (⚡ button or auto-detected): Complex refactoring, architecture questions
- **Gemini** (fallback): If Anthropic API is down
