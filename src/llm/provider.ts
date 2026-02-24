import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM Provider Abstraction
 *
 * DESIGN: Supports multiple backends, auto-detected from environment.
 * Priority order: anthropic → nebius → gemini (first configured wins).
 *
 * Model selection uses two abstract tiers:
 * - "fast"  → low-latency model per provider
 * - "power" → higher-quality model (falls back to fast if provider has one model)
 *
 * The system selects the tier automatically based on request complexity.
 */

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: { input: number; output: number };
  latencyMs: number;
}

export interface LLMConfig {
  anthropicApiKey?: string;
  nebiusApiKey?: string;
  geminiApiKey?: string;
  modelName?: string;
  providerType?: "anthropic" | "nebius" | "gemini";
}

export type ModelTier = "fast" | "power";

const MODELS: Record<string, { fast: string; power: string }> = {
  anthropic: { fast: "claude-sonnet-4-5-20250929", power: "claude-opus-4-6" },
  nebius:    { fast: "moonshotai/Kimi-K2.5",        power: "moonshotai/Kimi-K2.5" },
  gemini:    { fast: "gemini-2.0-flash",             power: "gemini-2.0-flash" },
};

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3.0,  output: 15.0 },
  "claude-opus-4-6":            { input: 15.0, output: 75.0 },
  "moonshotai/Kimi-K2.5":       { input: 0.50, output: 2.50 },
  "gemini-2.0-flash":           { input: 0.10, output: 0.40 },
};

export function estimateTokenCost(
  model: string,
  tokens: { input: number; output: number }
): number {
  const p = PRICING[model] ?? { input: 0, output: 0 };
  return (tokens.input / 1_000_000) * p.input + (tokens.output / 1_000_000) * p.output;
}

// Returns true if the request warrants the "power" tier.
export function isComplexRequest(userMessage: string, contextSize: number): boolean {
  const signals = [
    // Only truly multi-file architectural changes
    /refactor.*(across|multiple|all)\s+(files|services|modules)/i,
    /restructur.*entire/i,
    /migrat.*(database|schema|architecture)/i,
    /redesign.*system/i,
  ];
  // Only if BOTH complex pattern AND large context
  return signals.some((re) => re.test(userMessage)) && contextSize > 8000;
}

export class LLMProvider {
  private config: LLMConfig;
  private anthropic: Anthropic | null = null;
  private availableBackends: string[] = [];

  constructor(config: LLMConfig) {
    this.config = config;

    const anthropicKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    const nebiusKey    = config.nebiusApiKey    ?? process.env.NEBIUS_API_KEY    ?? "";
    const geminiKey    = config.geminiApiKey    ?? process.env.GEMINI_API_KEY    ?? "";

    if (anthropicKey) {
      this.anthropic = new Anthropic({ apiKey: anthropicKey });
      this.availableBackends.push("anthropic");
    }
    if (nebiusKey) this.availableBackends.push("nebius");
    if (geminiKey) this.availableBackends.push("gemini");
  }

  get backends(): string[] {
    return [...this.availableBackends];
  }

  async complete(
    systemPrompt: string,
    userMessage: string,
    options?: {
      forceModel?: ModelTier;
      forceBackend?: string;
      maxTokens?: number;
    }
  ): Promise<LLMResponse> {
    const contextSize = systemPrompt.length + userMessage.length;
    const tier: ModelTier =
      options?.forceModel ?? (isComplexRequest(userMessage, contextSize) ? "power" : "fast");
    const maxTokens = options?.maxTokens ?? 4096;
    const backendName = options?.forceBackend ?? this.availableBackends[0];

    if (!backendName) {
      throw new Error("No LLM backend configured. Set ANTHROPIC_API_KEY, NEBIUS_API_KEY, or GEMINI_API_KEY.");
    }

    const startIdx = this.availableBackends.indexOf(backendName);
    const chain = startIdx >= 0 ? this.availableBackends.slice(startIdx) : [backendName];

    let lastError: unknown;
    for (const backend of chain) {
      try {
        const model = MODELS[backend]?.[tier] ?? MODELS[backend]?.fast;
        if (!model) throw new Error(`Unknown backend: "${backend}"`);
        console.log(`[LLM:${backend}] tier=${tier} model=${model}`);
        return await this.callBackend(backend, systemPrompt, userMessage, model, maxTokens);
      } catch (err) {
        console.warn(`[LLM] Backend "${backend}" failed, trying next...`);
        lastError = err;
      }
    }
    throw lastError ?? new Error("All LLM backends failed");
  }

  private async callBackend(
    backend: string,
    systemPrompt: string,
    userMessage: string,
    model: string,
    maxTokens: number
  ): Promise<LLMResponse> {
    switch (backend) {
      case "anthropic": return this.anthropicComplete(systemPrompt, userMessage, model, maxTokens);
      case "nebius":    return this.nebiusComplete(systemPrompt, userMessage, model, maxTokens);
      case "gemini":    return this.geminiComplete(systemPrompt, userMessage, model, maxTokens);
      default:          throw new Error(`No implementation for backend: "${backend}"`);
    }
  }

  private async anthropicComplete(
    systemPrompt: string,
    userMessage: string,
    model: string,
    maxTokens: number
  ): Promise<LLMResponse> {
    if (!this.anthropic) throw new Error("Anthropic backend not initialised");

    const start = Date.now();
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        });

        const textBlock = response.content.find((c) => c.type === "text");
        return {
          content: textBlock?.text ?? "",
          model,
          tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
          latencyMs: Date.now() - start,
        };
      } catch (error: unknown) {
        const err = error as Record<string, unknown>;
        const status = (err?.status ?? err?.statusCode) as number | undefined;
        // 529 = Anthropic overloaded (non-standard)
        const retryable = status === 429 || status === 529 || status === 500 || status === 503;

        console.error(`[LLM:anthropic] attempt ${attempt} failed: ${status ?? String(err?.message)}`);

        if (retryable && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 8000)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("[LLM:anthropic] exhausted all retries");
  }

  private async nebiusComplete(
    systemPrompt: string,
    userMessage: string,
    model: string,
    maxTokens: number
  ): Promise<LLMResponse> {
    const apiKey = this.config.nebiusApiKey ?? process.env.NEBIUS_API_KEY;
    if (!apiKey) throw new Error("NEBIUS_API_KEY not set");

    const start = Date.now();
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch("https://api.studio.nebius.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user",   content: userMessage  },
            ],
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw Object.assign(new Error(`Nebius ${response.status}: ${body}`), { status: response.status });
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        return {
          content: data.choices?.[0]?.message?.content ?? "",
          model,
          tokensUsed: {
            input:  data.usage?.prompt_tokens    ?? 0,
            output: data.usage?.completion_tokens ?? 0,
          },
          latencyMs: Date.now() - start,
        };
      } catch (error: unknown) {
        const err = error as Record<string, unknown>;
        const status = err?.status as number | undefined;
        const retryable = status === 429 || status === 500 || status === 503;

        console.error(`[LLM:nebius] attempt ${attempt} failed: ${status ?? String(err?.message)}`);

        if (retryable && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, attempt - 1), 8000)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("[LLM:nebius] exhausted all retries");
  }

  private async geminiComplete(
    systemPrompt: string,
    userMessage: string,
    model: string,
    maxTokens: number
  ): Promise<LLMResponse> {
    const apiKey = this.config.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const start = Date.now();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      }
    );

    const data = (await response.json()) as Record<string, unknown>;
    const candidates  = data.candidates as Array<Record<string, unknown>> | undefined;
    const content     = candidates?.[0]?.content as Record<string, unknown> | undefined;
    const parts       = content?.parts as Array<Record<string, unknown>> | undefined;
    const text        = (parts?.[0]?.text as string) ?? "Gemini returned no content";
    const usage       = data.usageMetadata as Record<string, unknown> | undefined;

    return {
      content: text,
      model,
      tokensUsed: {
        input:  (usage?.promptTokenCount     as number) ?? 0,
        output: (usage?.candidatesTokenCount as number) ?? 0,
      },
      latencyMs: Date.now() - start,
    };
  }
}
