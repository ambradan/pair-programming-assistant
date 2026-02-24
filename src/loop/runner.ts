/**
 * Ralph Loop — autonomous coding loop with human-in-the-loop review.
 *
 * The loop runs as an async generator, yielding typed events that the
 * route layer pipes to SSE clients. Between each iteration the loop
 * can pause and wait for a human decision (accept / retry / skip / stop)
 * before proceeding. Auto-pilot mode skips the pause.
 */

import { AssistService, AssistResponse } from "../services/assist.service.js";
import { LLMProvider, estimateTokenCost } from "../llm/provider.js";
import {
  Task,
  parseTasks,
  getCompletionStatus,
  isAllComplete,
  getNextIncompleteTask,
  markTaskComplete,
} from "./prd.js";
import { generateCommitMessage, commitChanges } from "./commit-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HumanDecision = "accept" | "retry" | "skip" | "stop";

export interface LoopConfig {
  /** Markdown checklist of tasks to work through */
  prdContent: string;
  /** Absolute path to the project being worked on */
  projectPath: string;
  /** Max iterations before stopping. Default: 20 */
  maxIterations?: number;
  /** Auto-apply proposed changes to disk without asking. Default: true */
  autoApply?: boolean;
  /** Auto-commit after each accepted iteration. Default: false */
  autoCommit?: boolean;
  /** Skip human review and auto-accept all iterations. Default: false */
  autoPilot?: boolean;
  /** Stop immediately on LLM error. Default: false */
  failFast?: boolean;
  /** USD cost ceiling. Default: no limit */
  maxCost?: number;
  /** Force a model tier for all iterations */
  forceModel?: "fast" | "power";
}

export interface IterationResult {
  iteration: number;
  taskText: string;
  decision: HumanDecision | "auto";
  success: boolean;
  blocked: boolean;
  blockedReason?: string;
  appliedFiles: string[];
  costUsd?: number;
  durationMs: number;
  // Full AssistResponse preserved for the UI diff viewer
  assistResponse?: AssistResponse;
}

export interface LoopSession {
  id: string;
  config: LoopConfig;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  /** Mutable PRD — tasks get marked [x] as they complete */
  prdContent: string;
  tasks: Task[];
  currentIteration: number;
  currentTask: Task | null;
  /** Result waiting for human review (null when not paused) */
  pendingResult: AssistResponse | null;
  totalCost: number;
  totalTokens: { input: number; output: number };
  iterations: IterationResult[];
  startedAt: string;
  endedAt?: string;
  /** Resolved by the decide endpoint when user makes a choice */
  _decisionResolver: ((d: HumanDecision) => void) | null;
  /** Set to true to cancel after the current iteration */
  _cancelRequested: boolean;
}

export type LoopEvent =
  | { type: "iteration:start"; iteration: number; task: string }
  | { type: "iteration:paused"; iteration: number; task: string; result: AssistResponse }
  | { type: "iteration:end"; iteration: number; task: string; decision: HumanDecision | "auto"; success: boolean; appliedFiles: string[]; durationMs: number; costUsd?: number; result?: AssistResponse }
  | { type: "task:blocked"; iteration: number; task: string; reason: string }
  | { type: "commit:done"; iteration: number; hash?: string; message: string }
  | { type: "commit:failed"; iteration: number; error: string }
  | { type: "cost:update"; iterationCost: number; totalCost: number }
  | { type: "loop:end"; reason: "complete" | "stopped" | "max_iterations" | "cost_limit" | "cancelled" | "failed" };

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

const DECOMPOSE_SYSTEM_PROMPT = `You are a project planning assistant. You break down coding tasks into 3-10 concrete implementation steps.

You MUST respond with ONLY a valid JSON array. No prose, no markdown, no explanation — just the JSON array.

Each element is an object with exactly two keys:
- "task": string — imperative verb phrase (e.g. "Add JWT validation to auth middleware")
- "seq": integer starting at 1, ordered by dependency

Example response:
[{"task":"Extract auth logic into src/auth/jwt.ts","seq":1},{"task":"Add rate limiting middleware","seq":2},{"task":"Update route handlers to use new middleware","seq":3}]`;

interface DecomposeItem {
  task: string;
  seq: number;
}

/**
 * Parse the JSON array returned by the decompose LLM call.
 * Strips markdown fences and leading/trailing prose before parsing.
 */
function parseDecomposeJson(raw: string): DecomposeItem[] {
  let text = raw.trim();

  // Strip injected system tags (e.g. <system-reminder>…</system-reminder>)
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Extract the outermost [ ... ] block
  const start = text.indexOf("[");
  let end     = text.lastIndexOf("]");

  if (start === -1) {
    throw new Error("No JSON array in LLM output: " + text.slice(0, 300));
  }

  // Handle truncated output — if [ exists but ] is missing or before [,
  // close the array after the last complete object (ends with })
  if (end === -1 || end <= start) {
    const fragment = text.slice(start);
    const lastBrace = fragment.lastIndexOf("}");
    if (lastBrace === -1) {
      throw new Error("Truncated JSON with no complete objects: " + text.slice(0, 300));
    }
    text = fragment.slice(0, lastBrace + 1) + "]";
    end = text.length - 1;
  } else {
    text = text.slice(start, end + 1);
    end = text.length - 1;
  }

  const parsed = JSON.parse(text) as unknown[];

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("LLM returned an empty task list");
  }

  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, i) => ({
      // Accept "task", "description", or "name" keys
      task: String(item["task"] ?? item["description"] ?? item["name"] ?? "").trim(),
      seq:  typeof item["seq"] === "number" ? item["seq"]
          : typeof item["sequence"] === "number" ? item["sequence"]
          : i + 1,
    }))
    .filter((item) => item.task.length > 0)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Decompose a free-text user request into a PRD markdown checklist.
 * JSON output from the LLM guarantees a parseable structure regardless of model.
 */
export interface DecomposeResult {
  prdContent: string;
  model: string;
  latencyMs: number;
  tokensUsed: { input: number; output: number };
}

export async function decompose(
  llm: LLMProvider,
  message: string,
  projectContext: string
): Promise<DecomposeResult> {
  const parts = [`Project to decompose:\n${message}`];
  if (projectContext) parts.push(`Codebase context:\n${projectContext}`);
  parts.push("Respond with ONLY the JSON array:");
  const userPrompt = parts.join("\n\n");

  const response = await llm.complete(DECOMPOSE_SYSTEM_PROMPT, userPrompt, {
    forceModel: "power",
    maxTokens: 4096,
  });

  console.log(`[decompose] Raw LLM output (${response.content.length} chars): ${response.content.slice(0, 500)}`);

  const items = parseDecomposeJson(response.content);
  const prdContent = items.map((item) => `- [ ] ${item.task}`).join("\n");

  return {
    prdContent,
    model: response.model,
    latencyMs: response.latencyMs,
    tokensUsed: response.tokensUsed,
  };
}

// ---------------------------------------------------------------------------
// "Cannot complete" detection
// ---------------------------------------------------------------------------

const CANNOT_COMPLETE_PATTERNS: RegExp[] = [
  /(?:i )?(?:cannot|can't|am unable to|am not able to) (?:complete|finish|accomplish|do|perform) (?:this|the) task/i,
  /(?:this|the) task (?:cannot|can't) be completed/i,
  /unable to (?:complete|finish|accomplish) (?:this|the) task/i,
  /(?:i'?m|i am) (?:blocked|stuck) (?:on|by)/i,
  /(?:cannot|can't) proceed (?:with|further)/i,
  /task (?:is )?(?:impossible|infeasible|not possible)/i,
  /(?:i )?(?:need|require) (?:more information|clarification)/i,
  /(?:blocking|blocker|blocked)(?:\s+issue)?:/i,
  /this (?:is )?beyond (?:my|the) (?:capabilities|ability|scope)/i,
];

function detectCannotComplete(output: string): { blocked: boolean; reason: string | null } {
  for (const pattern of CANNOT_COMPLETE_PATTERNS) {
    const match = output.match(pattern);
    if (match) return { blocked: true, reason: match[0] };
  }
  return { blocked: false, reason: null };
}

// ---------------------------------------------------------------------------
// Progress summary (injected into subsequent iteration prompts)
// ---------------------------------------------------------------------------

function buildProgressSummary(iterations: IterationResult[]): string {
  if (iterations.length === 0) return "";

  const lines = iterations.map((it) => {
    const status = it.blocked ? "blocked" : it.success ? "done" : "failed";
    const files = it.appliedFiles.length > 0 ? `→ ${it.appliedFiles.join(", ")}` : "";
    return `${it.iteration}. [${status}] "${it.taskText}" ${files}`.trim();
  });

  return "Previous iterations:\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply changes to disk (same logic as /api/apply route)
// ---------------------------------------------------------------------------

async function applyChanges(
  projectPath: string,
  changes: AssistResponse["changes"]
): Promise<string[]> {
  const fs = await import("fs");
  const path = await import("path");
  const applied: string[] = [];

  for (const change of changes) {
    const absPath = path.join(projectPath, change.file);
    try {
      if (!fs.existsSync(absPath)) continue;

      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");

      // Backup before overwriting
      fs.writeFileSync(absPath + ".bak", content, "utf-8");

      const before = lines.slice(0, change.startLine - 1);
      const after = lines.slice(change.endLine);
      const proposed = change.proposedCode.split("\n");

      fs.writeFileSync(absPath, [...before, ...proposed, ...after].join("\n"), "utf-8");
      applied.push(change.file);
    } catch {
      // Skip files that fail — they'll show up as missing from appliedFiles
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Main loop — async generator
// ---------------------------------------------------------------------------

export async function* runLoop(
  session: LoopSession,
  assistService: AssistService,
  llm: LLMProvider
): AsyncGenerator<LoopEvent> {
  const { config } = session;
  const maxIterations = config.maxIterations ?? 20;
  const autoPilot = config.autoPilot ?? false;

  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (session._cancelRequested) {
      session.status = "cancelled";
      session.endedAt = new Date().toISOString();
      yield { type: "loop:end", reason: "cancelled" };
      return;
    }

    // Re-parse tasks from the mutable PRD (updated after each completion)
    session.tasks = parseTasks(session.prdContent);
    session.currentIteration = iteration;

    if (isAllComplete(session.tasks)) {
      session.status = "completed";
      session.endedAt = new Date().toISOString();
      yield { type: "loop:end", reason: "complete" };
      return;
    }

    const task = getNextIncompleteTask(session.tasks);
    if (!task) break;

    session.currentTask = task;
    const iterStart = Date.now();

    yield { type: "iteration:start", iteration, task: task.text };

    // Build the message for this iteration
    const progressSummary = buildProgressSummary(session.iterations);
    const iterationMessage = [
      `Task to complete: ${task.text}`,
      progressSummary ? `\n${progressSummary}` : "",
    ].join("\n").trim();

    // Call AssistService — this handles all LLM logic, context, parsing
    let assistResponse: AssistResponse;
    try {
      assistResponse = await assistService.assist({
        message: iterationMessage,
        projectPath: config.projectPath,
        forceModel: config.forceModel,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveFailures++;

      const iterResult: IterationResult = {
        iteration,
        taskText: task.text,
        decision: "skip",
        success: false,
        blocked: false,
        appliedFiles: [],
        durationMs: Date.now() - iterStart,
      };
      session.iterations.push(iterResult);
      session.currentTask = null;

      yield {
        type: "iteration:end",
        iteration,
        task: task.text,
        decision: "skip",
        success: false,
        appliedFiles: [],
        durationMs: iterResult.durationMs,
      };

      if (config.failFast || consecutiveFailures >= maxConsecutiveFailures) {
        session.status = "failed";
        session.endedAt = new Date().toISOString();
        yield { type: "loop:end", reason: "failed" };
        return;
      }

      // Exponential backoff between retries
      const backoff = Math.min(1000 * Math.pow(2, consecutiveFailures - 1), 8000);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    consecutiveFailures = 0;

    // Accumulate cost from token counts
    const costUsd = estimateTokenCost(assistResponse.model, assistResponse.tokensUsed);
    session.totalCost += costUsd;
    session.totalTokens.input  += assistResponse.tokensUsed.input;
    session.totalTokens.output += assistResponse.tokensUsed.output;

    if (costUsd > 0) {
      yield { type: "cost:update", iterationCost: costUsd, totalCost: session.totalCost };
    }

    // Detect "cannot complete" in the LLM's reasoning output
    const reasoningText = assistResponse.reasoning.whyThisSolution_en || assistResponse.reasoning.whyThisSolution;
    const { blocked, reason: blockedReason } = detectCannotComplete(reasoningText);

    if (blocked) {
      session.iterations.push({
        iteration,
        taskText: task.text,
        decision: "skip",
        success: false,
        blocked: true,
        blockedReason: blockedReason ?? undefined,
        appliedFiles: [],
        durationMs: Date.now() - iterStart,
        assistResponse,
      });
      session.currentTask = null;

      yield { type: "task:blocked", iteration, task: task.text, reason: blockedReason ?? "LLM indicated it cannot complete this task" };
      yield { type: "iteration:end", iteration, task: task.text, decision: "skip", success: false, appliedFiles: [], durationMs: Date.now() - iterStart };
      continue;
    }

    // --- Human-in-the-loop decision ---
    let decision: HumanDecision | "auto";

    if (autoPilot) {
      decision = "auto";
    } else {
      // Pause and wait for the human
      session.status = "paused";
      session.pendingResult = assistResponse;

      yield { type: "iteration:paused", iteration, task: task.text, result: assistResponse };

      // Wait for POST /api/loop/decide/:id to resolve this promise
      decision = await new Promise<HumanDecision>((resolve) => {
        session._decisionResolver = resolve;
      });

      session.status = "running";
      session.pendingResult = null;
      session._decisionResolver = null;
    }

    // Handle stop
    if (decision === "stop") {
      session.status = "cancelled";
      session.endedAt = new Date().toISOString();
      yield { type: "loop:end", reason: "stopped" };
      return;
    }

    // Handle retry — re-run same iteration index without advancing
    if (decision === "retry") {
      iteration--; // will be incremented by for-loop, net effect: same iteration
      yield { type: "iteration:end", iteration, task: task.text, decision: "retry", success: false, appliedFiles: [], durationMs: Date.now() - iterStart, result: assistResponse };
      continue;
    }

    // Handle skip — move on without applying
    if (decision === "skip") {
      session.iterations.push({
        iteration,
        taskText: task.text,
        decision: "skip",
        success: true,
        blocked: false,
        appliedFiles: [],
        durationMs: Date.now() - iterStart,
        assistResponse,
      });
      // Mark task complete even on skip so the loop advances
      session.prdContent = markTaskComplete(session.prdContent, task.lineNumber);
      session.tasks = parseTasks(session.prdContent);
      session.currentTask = null;

      yield { type: "iteration:end", iteration, task: task.text, decision: "skip", success: true, appliedFiles: [], durationMs: Date.now() - iterStart, result: assistResponse };
      continue;
    }

    // Accept (or auto) — apply changes
    let appliedFiles: string[] = [];
    if (config.autoApply !== false && assistResponse.changes.length > 0) {
      appliedFiles = await applyChanges(config.projectPath, assistResponse.changes);
    }

    // Mark task complete in the PRD
    session.prdContent = markTaskComplete(session.prdContent, task.lineNumber);
    session.tasks = parseTasks(session.prdContent);

    const durationMs = Date.now() - iterStart;

    const iterResult: IterationResult = {
      iteration,
      taskText: task.text,
      decision,
      success: true,
      blocked: false,
      appliedFiles,
      durationMs,
      assistResponse,
    };
    session.iterations.push(iterResult);
    session.currentTask = null;

    yield { type: "iteration:end", iteration, task: task.text, decision, success: true, appliedFiles, durationMs, result: assistResponse };

    // Auto-commit if enabled and we applied something
    if (config.autoCommit && appliedFiles.length > 0) {
      const outputSummary = [
        assistResponse.reasoning.whyThisSolution_en,
        assistResponse.intent.target,
      ].filter(Boolean).join(". ");

      const commitMsg = await generateCommitMessage(llm, task.text, appliedFiles, outputSummary);
      const finalMsg = commitMsg ?? `feat: complete task — ${task.text.slice(0, 60)}`;

      const commitResult = await commitChanges(config.projectPath, finalMsg);
      if (commitResult.success && !commitResult.noChanges) {
        yield { type: "commit:done", iteration, hash: commitResult.hash, message: finalMsg.split("\n")[0] };
      } else if (!commitResult.success) {
        yield { type: "commit:failed", iteration, error: commitResult.message };
      }
    }

    // Cost limit check
    if (config.maxCost !== undefined && session.totalCost >= config.maxCost) {
      session.status = "completed";
      session.endedAt = new Date().toISOString();
      yield { type: "loop:end", reason: "cost_limit" };
      return;
    }
  }

  // Reached max iterations
  session.tasks = parseTasks(session.prdContent);
  if (isAllComplete(session.tasks)) {
    session.status = "completed";
    yield { type: "loop:end", reason: "complete" };
  } else {
    session.status = "completed";
    yield { type: "loop:end", reason: "max_iterations" };
  }
  session.endedAt = new Date().toISOString();
}
