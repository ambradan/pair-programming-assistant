import {
  ProjectIndex,
  searchIndex,
  findDependents,
  SymbolEntry,
} from "../indexer/project-indexer.js";
import {
  ProjectMap,
  serializeMapForLLM,
} from "../indexer/project-map.js";
import { LLMProvider } from "../llm/provider.js";

export interface AssistRequest {
  message: string;
  projectPath: string;
  forceModel?: "sonnet" | "opus";
}

export interface CodeChange {
  file: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  proposedCode: string;
  explanation: {
    technical: string;
    plain: string;
  };
}

export interface AssistResponse {
  intent: {
    action: string;
    target: string;
    confidence: number;
  };
  changes: CodeChange[];
  dependentFiles: string[];
  reasoning: {
    whyThisSolution: string;
    alternatives: Array<{
      description: string;
      whyNot: string;
    }>;
  };
  model: string;
  latencyMs: number;
  navigationOrder: string[];
}

const SYSTEM_PROMPT = `You are a pair programming assistant. You analyze code and propose precise modifications.

You MUST respond with ONLY a JSON object. No markdown fences. No backticks. No explanation text. Just raw JSON starting with { and ending with }.

Required JSON structure:
{
  "intent": {"action": "add|remove|refactor|fix|move", "target": "description", "confidence": 0.85},
  "changes": [
    {
      "file": "src/path/to/file.ts",
      "startLine": 1,
      "endLine": 50,
      "originalCode": "the exact original code",
      "proposedCode": "the new replacement code",
      "explanation": {
        "technical": "one sentence technical explanation",
        "plain": "one sentence simple explanation"
      }
    }
  ],
  "reasoning": {
    "whyThisSolution": "brief justification",
    "alternatives": [{"description": "other approach", "whyNot": "why not chosen"}]
  },
  "navigationOrder": ["file1.ts", "file2.ts"]
}

Rules:
- Use ONLY files that exist in the provided codebase
- originalCode must match actual code in the file
- Line numbers must be accurate
- Keep explanations to 1-2 sentences max
- If unsure, set confidence below 0.5`;

export class AssistService {
  constructor(
    private llm: LLMProvider,
    private index: ProjectIndex,
    private projectMap?: ProjectMap
  ) {}

  async assist(request: AssistRequest): Promise<AssistResponse> {
    const startTime = Date.now();

    // Step 1: Search index for relevant code
    const searchResults = searchIndex(this.index, request.message);

    // Step 2: Build smart context (map + targeted code)
    const context = this.buildSmartContext(searchResults.slice(0, 3));

    // Step 3: Call LLM
    const userMessage = `USER REQUEST: ${request.message}\n\n${context}\n\nRespond with JSON only. No backticks. No markdown.`;

    const llmResponse = await this.llm.complete(SYSTEM_PROMPT, userMessage, {
      forceModel: request.forceModel,
    });

    // Step 4: Parse response with bulletproof JSON extraction
    let parsed: any;
    try {
      parsed = this.extractJSON(llmResponse.content);
    } catch (e: any) {
      return {
        intent: { action: "error", target: "parse_failure", confidence: 0 },
        changes: [],
        dependentFiles: [],
        reasoning: {
          whyThisSolution: `JSON parse failed: ${e.message}. Raw: ${llmResponse.content.substring(0, 300)}`,
          alternatives: [],
        },
        model: llmResponse.model,
        latencyMs: Date.now() - startTime,
        navigationOrder: [],
      };
    }

    // Step 5: Find dependent files
    const affectedFiles = (parsed.changes ?? []).map((c: any) => c.file) as string[];
    const allDependents = new Set<string>();
    for (const file of affectedFiles) {
      findDependents(this.index, file).forEach((d) => allDependents.add(d));
    }

    const navigationOrder =
      parsed.navigationOrder ??
      [...affectedFiles, ...allDependents].filter((f, i, arr) => arr.indexOf(f) === i);

    return {
      intent: parsed.intent ?? { action: "unknown", target: "unknown", confidence: 0 },
      changes: parsed.changes ?? [],
      dependentFiles: [...allDependents],
      reasoning: parsed.reasoning ?? { whyThisSolution: "No reasoning provided", alternatives: [] },
      model: llmResponse.model,
      latencyMs: Date.now() - startTime,
      navigationOrder,
    };
  }

  /**
   * Bulletproof JSON extractor.
   * Handles all the ways LLMs return JSON:
   * 1. Clean JSON: {"intent": ...}
   * 2. Markdown wrapped: ```json\n{...}\n```
   * 3. Text before/after: "Here's the JSON:\n{...}\nHope this helps"
   * 4. Escaped newlines in strings
   */
  private extractJSON(raw: string): any {
    let text = raw.trim();

    // Strip markdown code fences
    text = text.replace(/^```(?:json|JSON)?\s*\n?/g, "");
    text = text.replace(/\n?\s*```\s*$/g, "");
    text = text.trim();

    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch {
      // Continue to extraction
    }

    // Extract the outermost JSON object { ... }
    let depth = 0;
    let start = -1;
    let end = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (start === -1 || end === -1) {
      throw new Error("No JSON object found in response");
    }

    const jsonStr = text.substring(start, end + 1);

    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // Last resort: try to fix common issues
      const fixed = jsonStr
        .replace(/,\s*}/g, "}") // trailing commas
        .replace(/,\s*]/g, "]"); // trailing commas in arrays
      return JSON.parse(fixed);
    }
  }

  /**
   * Smart context: compressed ProjectMap + raw code only for target files.
   * ~400-700 tokens instead of ~3000-5000 = much faster LLM response.
   */
  private buildSmartContext(
    results: Array<{
      file: string;
      symbol?: SymbolEntry;
      relevance: number;
      matchType: string;
    }>
  ): string {
    const parts: string[] = [];

    // Part 1: Compressed project map
    if (this.projectMap) {
      parts.push(serializeMapForLLM(this.projectMap));
    }

    // Part 2: Raw code for target files only
    parts.push("\n=== DETAILED CODE (files likely to be modified) ===");

    for (const result of results) {
      const entry = this.index.files.get(result.file);
      if (!entry) continue;

      parts.push(`\n--- ${result.file} ---`);

      if (result.symbol) {
        const start = result.symbol.line - 1;
        const end = result.symbol.endLine;
        parts.push(`Lines ${result.symbol.line}-${result.symbol.endLine}:`);
        parts.push(
          entry.lines
            .slice(start, end)
            .map((l, i) => `${(start + i + 1).toString().padStart(4)} | ${l}`)
            .join("\n")
        );
      } else if (entry.lines.length <= 80) {
        parts.push(
          entry.lines
            .map((l, i) => `${(i + 1).toString().padStart(4)} | ${l}`)
            .join("\n")
        );
      } else {
        parts.push(
          entry.lines
            .slice(0, 40)
            .map((l, i) => `${(i + 1).toString().padStart(4)} | ${l}`)
            .join("\n")
        );
        parts.push(`... (${entry.lines.length - 40} more lines)`);
      }
    }

    return parts.join("\n");
  }

  setProjectMap(map: ProjectMap): void {
    this.projectMap = map;
  }
}
