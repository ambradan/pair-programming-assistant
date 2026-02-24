/**
 * PRD parsing — extract tasks from markdown checkboxes.
 */

export interface Task {
  text: string;
  complete: boolean;
  lineNumber: number; // 1-indexed
}

export interface ValidationWarning {
  lineNumber: number;
  lineContent: string;
  message: string;
}

// Matches: - [ ] text  or  - [x] text  or  - [X] text
const CHECKBOX_PATTERN = /^(\s*-\s*\[)([ xX])(\]\s*)(.*)$/;

const MALFORMED_CHECKBOX_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*-\s*\[\]/, "Missing space inside brackets (should be '- [ ]')"],
  [/^\s*-\s*\[[^\]]{2,}\]/, "Invalid checkbox content (should be '[ ]' or '[x]')"],
  [/^\s*-\s*\[[ xX]\][^\s]/, "Missing space after checkbox (should be '- [ ] text')"],
  [/^\s*-\s*[\(<][^\)\>]*[\)>]/, "Invalid checkbox format (use square brackets: '- [ ]')"],
  [/^\s*-\s*\[[ xX][^\]]*$/, "Missing closing bracket in checkbox"],
];

/**
 * Parse markdown content and extract checkbox tasks.
 */
export function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHECKBOX_PATTERN);
    if (match) {
      tasks.push({
        text: match[4].trim(),
        complete: match[2].toLowerCase() === "x",
        lineNumber: i + 1,
      });
    }
  }

  return tasks;
}

/**
 * Mark a task complete by replacing its checkbox in the PRD content.
 * Returns the updated content string.
 */
export function markTaskComplete(content: string, lineNumber: number): string {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  if (idx >= 0 && idx < lines.length) {
    lines[idx] = lines[idx].replace(/\[\s\]/, "[x]");
  }
  return lines.join("\n");
}

export function getCompletionStatus(tasks: Task[]): { completed: number; total: number } {
  return { completed: tasks.filter((t) => t.complete).length, total: tasks.length };
}

export function isAllComplete(tasks: Task[]): boolean {
  return tasks.length === 0 || tasks.every((t) => t.complete);
}

export function getNextIncompleteTask(tasks: Task[]): Task | null {
  return tasks.find((t) => !t.complete) ?? null;
}

/**
 * Validate PRD for common authoring mistakes.
 */
export function validatePrd(content: string): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const match = line.match(CHECKBOX_PATTERN);
    if (match) {
      const taskText = match[4].trim();
      if (!taskText) {
        warnings.push({
          lineNumber: i + 1,
          lineContent: line,
          message: "Empty task text (checkbox has no description)",
        });
      }
      continue;
    }

    for (const [pattern, message] of MALFORMED_CHECKBOX_PATTERNS) {
      if (pattern.test(line)) {
        warnings.push({ lineNumber: i + 1, lineContent: line, message });
        break;
      }
    }
  }

  return warnings;
}
