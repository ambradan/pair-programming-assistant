/**
 * Git commit management for the ralph loop.
 *
 * Uses the LLM to generate Conventional Commits messages, then performs
 * async git operations (non-blocking).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { LLMProvider } from "../llm/provider.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------

const COMMIT_SYSTEM_PROMPT = `You write git commit messages using Conventional Commits format.

Format: <type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
- feat: new feature
- fix: bug fix
- refactor: code change that is not a bug fix or feature
- chore: tooling, deps, config

Rules:
- Subject line: 72 chars max, lowercase after the colon, imperative mood
- Scope is optional but encouraged (e.g. feat(auth): add jwt validation)
- Body is optional, blank line before it, explains WHY not WHAT
- NEVER add Co-Authored-By, Signed-off-by, or any signature lines
- NEVER use backticks, code fences, or markdown formatting
- Output ONLY the commit message, no preamble, no explanation`;

const COMMIT_USER_TEMPLATE = `Task completed: {taskText}

Files changed:
{filesChanged}

LLM output summary:
{outputSummary}

Write the commit message now.`;

/**
 * Generate a Conventional Commits message via LLM for a completed loop iteration.
 * Returns null if generation fails — caller should fall back to a plain message.
 */
export async function generateCommitMessage(
  llm: LLMProvider,
  taskText: string,
  filesChanged: string[],
  llmOutputSummary: string
): Promise<string | null> {
  const userPrompt = COMMIT_USER_TEMPLATE
    .replace("{taskText}", taskText)
    .replace("{filesChanged}", filesChanged.length > 0 ? filesChanged.join("\n") : "(none)")
    .replace("{outputSummary}", llmOutputSummary.slice(0, 1500));

  try {
    const response = await llm.complete(COMMIT_SYSTEM_PROMPT, userPrompt, {
      maxTokens: 256,
      forceModel: "fast",
    });

    let msg = response.content.trim();

    // Strip accidental markdown fences
    msg = msg.replace(/^```\w*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

    // Strip accidental signature lines
    const lines = msg.split("\n").filter((line) => {
      const l = line.toLowerCase();
      return !l.startsWith("co-author") &&
             !l.startsWith("signed-off") &&
             !l.startsWith("co-authored");
    });

    return lines.join("\n").trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

export interface CommitResult {
  success: boolean;
  hash?: string;
  message: string;
  noChanges?: boolean;
}

/**
 * Stage all tracked changes (excluding PRD and backup files) and commit.
 */
export async function commitChanges(
  projectPath: string,
  commitMessage: string,
  excludeFiles: string[] = []
): Promise<CommitResult> {
  // Always exclude PRD artifacts and editor backups
  const alwaysExclude = ["PRD.md", "progress.txt", "*.bak"];
  const allExcludes = [...alwaysExclude, ...excludeFiles];
  const excludeArgs = allExcludes.map((f) => `:!${f}`);

  try {
    // Stage everything except excluded patterns
    await execFileAsync(
      "git",
      ["add", "-A", "--", ".", ...excludeArgs],
      { cwd: projectPath }
    );

    // Check for staged changes — git diff --cached --quiet exits 0 if no changes
    try {
      await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: projectPath });
      return { success: true, noChanges: true, message: "No changes to commit" };
    } catch {
      // Exit code 1 = staged changes exist — proceed
    }

    const { stdout } = await execFileAsync(
      "git",
      ["commit", "-m", commitMessage],
      { cwd: projectPath }
    );

    // Extract hash from output like "[main abc1234] message"
    const hashMatch = stdout.match(/\[[\w/]+\s+([0-9a-f]+)\]/);

    return { success: true, hash: hashMatch?.[1], message: stdout.trim() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("command not found")) {
      return { success: false, message: "git not found in PATH" };
    }
    return { success: false, message: `git commit failed: ${msg}` };
  }
}
