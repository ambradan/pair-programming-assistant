import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM Provider Abstraction
 *
 * DESIGN: Complexity detection determines which model to use.
 * - Simple requests (rename, add field, small refactor) → Sonnet (~3s)
 * - Complex requests (multi-file refactor, architecture change) → Opus (~10-15s)
 * - Fallback if Anthropic fails → Gemini (if configured)
 *
 * The user never chooses the model. The system does, based on heuristics.
 */

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: { input: number; output: number };
  latencyMs: number;
}

export interface LLMConfig {
  anthropicApiKey: string;
  geminiApiKey?: string;
  defaultModel?: string;
  opusModel?: string;
  sonnetModel?: string;
}

const SONNET_MODEL = "claude-sonnet-4-5-20250929";
const OPUS_MODEL = "claude-opus-4-6";

/**
 * Complexity heuristics for model selection.
 * Returns true if the request warrants Opus.
 */
function isComplexRequest(userMessage: string, contextSize: number): boolean {
  const complexitySignals = [
    // Only truly multi-file architectural changes
    /refactor.*(across|multiple|all)\s+(files|services|modules)/i,
    /restructur.*entire/i,
    /migrat.*(database|schema|architecture)/i,
    /redesign.*system/i,
  ];

  const matchesComplexPattern = complexitySignals.some((re) =>
    re.test(userMessage)
  );

  // Only if BOTH complex pattern AND large context
  return matchesComplexPattern && contextSize > 8000;
}

export class LLMProvider {
  private anthropic: Anthropic;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
    });
  }

  /**
   * Send a request to the LLM.
   * Model is selected automatically based on complexity.
   */
  async complete(
    systemPrompt: string,
    userMessage: string,
    options?: {
      forceModel?: "sonnet" | "opus";
      maxTokens?: number;
    }
  ): Promise<LLMResponse> {
    const contextSize = systemPrompt.length + userMessage.length;
    const useOpus =
      options?.forceModel === "opus" ||
      (!options?.forceModel && isComplexRequest(userMessage, contextSize));

    const model = useOpus ? OPUS_MODEL : SONNET_MODEL;
    const maxTokens = options?.maxTokens ?? 2048;

    const start = Date.now();

    try {
      console.log(`[LLM] Calling ${model}, context size: ${contextSize} chars`);
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });

      const latencyMs = Date.now() - start;

      const textContent = response.content.find((c) => c.type === "text");

      return {
        content: textContent?.text ?? "",
        model,
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        latencyMs,
      };
    } catch (error: any) {
      console.error(`[LLM] Anthropic API error:`, error?.message ?? error);
      // Fallback to Gemini if configured
      if (this.config.geminiApiKey) {
        console.warn(
          `Anthropic API failed, falling back to Gemini: ${error}`
        );
        return this.geminiComplete(systemPrompt, userMessage, maxTokens);
      }
      throw error;
    }
  }

  /**
   * Gemini fallback via REST API.
   */
  private async geminiComplete(
    systemPrompt: string,
    userMessage: string,
    maxTokens: number
  ): Promise<LLMResponse> {
    const start = Date.now();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.config.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `${systemPrompt}\n\n${userMessage}` }],
            },
          ],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      }
    );

    const data: any = await response.json();
    const latencyMs = Date.now() - start;

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? "Gemini returned no content";

    return {
      content: text,
      model: "gemini-2.0-flash",
      tokensUsed: { input: 0, output: 0 }, // Gemini doesn't report this the same way
      latencyMs,
    };
  }
}
