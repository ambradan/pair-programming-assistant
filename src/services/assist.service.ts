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
import { LLMProvider, ModelTier } from "../llm/provider.js";

export interface AssistRequest {
  message: string;
  projectPath: string;
  forceModel?: ModelTier;
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
    technical_en: string;
    plain_en: string;
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
    whyThisSolution_en: string;
    alternatives: Array<{
      description: string;
      description_en: string;
      whyNot: string;
    }>;
  };
  model: string;
  latencyMs: number;
  tokensUsed: { input: number; output: number };
  navigationOrder: string[];
}

/**
 * XML-based prompt. LLMs are MUCH better at producing well-formed XML
 * with code inside CDATA-like blocks than at producing valid JSON with
 * escaped code strings. This eliminates parse failures permanently.
 */
const SYSTEM_PROMPT = `You are a pair programming assistant. You analyze code and propose precise modifications.

Respond using EXACTLY this XML structure. No other text before or after.
All explanations, reasoning, and alternatives MUST be in Italian. Add English translations in the _en tags.

<response>
<intent action="add|remove|refactor|fix|move" target="descrizione in italiano" confidence="0.85"/>

<change file="src/path/to/file.ts" startLine="10" endLine="20">
<original>
first few lines of original code for context
</original>
<proposed>
the complete replacement code
</proposed>
<technical>Spiegazione tecnica in italiano</technical>
<technical_en>Technical explanation in English</technical_en>
<plain>Spiegazione semplice in italiano</plain>
<plain_en>Simple explanation in English</plain_en>
</change>

<reasoning>Motivazione della soluzione in italiano</reasoning>
<reasoning_en>Solution reasoning in English</reasoning_en>

<alternative description="altro approccio" description_en="other approach">Perché non è stato scelto</alternative>

<navigation>file1.ts,file2.ts</navigation>
</response>

Rules:
- You can include multiple <change> blocks and multiple <alternative> blocks
- Code inside <original> and <proposed> is verbatim — do NOT escape it
- <original> should contain only the first 3 and last 2 lines for context, not the full code
- <proposed> must contain the COMPLETE replacement code for the line range
- Line numbers must be accurate
- Use ONLY files that exist in the provided codebase
- If unsure, set confidence below 0.5
- ALL text (intent target, technical, plain, reasoning, alternative) MUST be in Italian with English in _en tags`;

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
    const userMessage = `USER REQUEST: ${request.message}\n\n${context}`;

    const llmResponse = await this.llm.complete(SYSTEM_PROMPT, userMessage, {
      forceModel: request.forceModel,
    });

    // Step 4: Parse XML response — robust, no JSON fragility
    const parsed = this.parseXMLResponse(llmResponse.content);

    // Step 5: Find dependent files
    const affectedFiles = parsed.changes.map((c) => c.file);
    const allDependents = new Set<string>();
    for (const file of affectedFiles) {
      findDependents(this.index, file).forEach((d) => allDependents.add(d));
    }

    const navigationOrder =
      parsed.navigationOrder.length > 0
        ? parsed.navigationOrder
        : [...affectedFiles, ...allDependents].filter(
            (f, i, arr) => arr.indexOf(f) === i
          );

    return {
      intent: parsed.intent,
      changes: parsed.changes,
      dependentFiles: [...allDependents],
      reasoning: parsed.reasoning,
      model: llmResponse.model,
      latencyMs: Date.now() - startTime,
      tokensUsed: llmResponse.tokensUsed,
      navigationOrder,
    };
  }

  /**
   * Parse the XML-structured LLM response.
   *
   * This is intentionally NOT a full XML parser. It uses regex to extract
   * tagged blocks. This is robust because:
   * - Code inside tags is verbatim (no escaping needed)
   * - Missing tags -> safe defaults (no crash)
   * - Malformed response -> partial extraction still works
   * - Truncated response -> extracts whatever was completed
   */
  private parseXMLResponse(raw: string): {
    intent: { action: string; target: string; confidence: number };
    changes: CodeChange[];
    reasoning: {
      whyThisSolution: string;
      whyThisSolution_en: string;
      alternatives: Array<{ description: string; description_en: string; whyNot: string }>;
    };
    navigationOrder: string[];
  } {
    // --- Intent ---
    const intentMatch = raw.match(
      /<intent\s+action="([^"]*)"\s+target="([^"]*)"\s+confidence="([^"]*)"\s*\/?>/
    );
    const intent = {
      action: intentMatch?.[1] ?? "unknown",
      target: intentMatch?.[2] ?? "unknown",
      confidence: parseFloat(intentMatch?.[3] ?? "0") || 0,
    };

    // --- Changes ---
    const changes: CodeChange[] = [];
    const changeRegex =
      /<change\s+file="([^"]*)"\s+startLine="(\d+)"\s+endLine="(\d+)"[^>]*>([\s\S]*?)<\/change>/g;
    let changeMatch;

    while ((changeMatch = changeRegex.exec(raw)) !== null) {
      const block = changeMatch[4];

      const originalMatch = block.match(
        /<original>([\s\S]*?)<\/original>/
      );
      const proposedMatch = block.match(
        /<proposed>([\s\S]*?)<\/proposed>/
      );
      const technicalMatch = block.match(
        /<technical>([\s\S]*?)<\/technical>/
      );
      const technicalEnMatch = block.match(
        /<technical_en>([\s\S]*?)<\/technical_en>/
      );
      const plainMatch = block.match(/<plain>([\s\S]*?)<\/plain>/);
      const plainEnMatch = block.match(/<plain_en>([\s\S]*?)<\/plain_en>/);

      changes.push({
        file: changeMatch[1],
        startLine: parseInt(changeMatch[2], 10),
        endLine: parseInt(changeMatch[3], 10),
        originalCode: (originalMatch?.[1] ?? "").trim(),
        proposedCode: (proposedMatch?.[1] ?? "").trim(),
        explanation: {
          technical: (technicalMatch?.[1] ?? "Nessuna spiegazione").trim(),
          technical_en: (technicalEnMatch?.[1] ?? "No explanation").trim(),
          plain: (plainMatch?.[1] ?? "Nessuna spiegazione").trim(),
          plain_en: (plainEnMatch?.[1] ?? "No explanation").trim(),
        },
      });
    }

    // --- Reasoning ---
    const reasoningMatch = raw.match(
      /<reasoning>([\s\S]*?)<\/reasoning>/
    );
    const reasoningEnMatch = raw.match(
      /<reasoning_en>([\s\S]*?)<\/reasoning_en>/
    );

    // --- Alternatives ---
    const alternatives: Array<{ description: string; description_en: string; whyNot: string }> = [];
    const altRegex =
      /<alternative\s+description="([^"]*)"(?:\s+description_en="([^"]*)")?>([\s\S]*?)<\/alternative>/g;
    let altMatch;
    while ((altMatch = altRegex.exec(raw)) !== null) {
      alternatives.push({
        description: altMatch[1],
        description_en: altMatch[2] ?? altMatch[1],
        whyNot: altMatch[3].trim(),
      });
    }

    // --- Navigation ---
    const navMatch = raw.match(
      /<navigation>([\s\S]*?)<\/navigation>/
    );
    const navigationOrder = navMatch
      ? navMatch[1]
          .trim()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // --- Fallback: if XML parsing got nothing, try JSON as last resort ---
    if (changes.length === 0 && intent.action === "unknown") {
      try {
        const jsonParsed = this.fallbackJSONParse(raw);
        if (jsonParsed) return jsonParsed;
      } catch {
        // Ignore — return what we have
      }
    }

    return {
      intent,
      changes,
      reasoning: {
        whyThisSolution: (reasoningMatch?.[1] ?? "Nessuna motivazione fornita").trim(),
        whyThisSolution_en: (reasoningEnMatch?.[1] ?? "No reasoning provided").trim(),
        alternatives,
      },
      navigationOrder,
    };
  }

  /**
   * Last-resort JSON fallback in case the LLM ignores the XML instruction
   * and returns JSON anyway.
   */
  private fallbackJSONParse(raw: string): {
    intent: { action: string; target: string; confidence: number };
    changes: CodeChange[];
    reasoning: {
      whyThisSolution: string;
      whyThisSolution_en: string;
      alternatives: Array<{ description: string; description_en: string; whyNot: string }>;
    };
    navigationOrder: string[];
  } | null {
    let text = raw.trim();

    // Strip markdown fences
    text = text.replace(/^```(?:json|JSON)?\s*\n?/g, "");
    text = text.replace(/\n?\s*```\s*$/g, "");
    text = text.trim();

    // Find outermost { ... }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace === -1) return null;

    let jsonStr: string;
    if (lastBrace > firstBrace) {
      jsonStr = text.substring(firstBrace, lastBrace + 1);
    } else {
      // Truncated — try to close it
      jsonStr = text.substring(firstBrace);
      jsonStr = jsonStr.replace(/,\s*"[^"]*"?\s*:?\s*("[^"]*)?$/, "");
      jsonStr = jsonStr.replace(/,\s*$/, "");
      let openBraces = 0;
      let openBrackets = 0;
      let inStr = false;
      let esc = false;
      for (const ch of jsonStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") openBraces++;
        if (ch === "}") openBraces--;
        if (ch === "[") openBrackets++;
        if (ch === "]") openBrackets--;
      }
      for (let i = 0; i < openBrackets; i++) jsonStr += "]";
      for (let i = 0; i < openBraces; i++) jsonStr += "}";
    }

    jsonStr = jsonStr.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");

    try {
      const parsed = JSON.parse(jsonStr);
      const changes = (parsed.changes ?? []).map((c: any) => ({
        ...c,
        explanation: {
          technical: c.explanation?.technical ?? "",
          technical_en: c.explanation?.technical_en ?? c.explanation?.technical ?? "",
          plain: c.explanation?.plain ?? "",
          plain_en: c.explanation?.plain_en ?? c.explanation?.plain ?? "",
        },
      }));
      return {
        intent: parsed.intent ?? { action: "unknown", target: "unknown", confidence: 0 },
        changes,
        reasoning: {
          whyThisSolution: parsed.reasoning?.whyThisSolution ?? "Nessuna motivazione",
          whyThisSolution_en: parsed.reasoning?.whyThisSolution_en ?? parsed.reasoning?.whyThisSolution ?? "No reasoning",
          alternatives: (parsed.reasoning?.alternatives ?? []).map((a: any) => ({
            description: a.description ?? "",
            description_en: a.description_en ?? a.description ?? "",
            whyNot: a.whyNot ?? "",
          })),
        },
        navigationOrder: parsed.navigationOrder ?? [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Smart context: compressed ProjectMap + raw code only for target files.
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

    if (this.projectMap) {
      parts.push(serializeMapForLLM(this.projectMap));
    }

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
