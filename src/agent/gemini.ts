/**
 * Gemini adapters for the reasoning model, the entailment judge, and the
 * retrieval embedder. Server-side only: construct them in a Node process
 * that holds the API key; never ship the key to the browser.
 *
 * No tools are passed to the model. In particular Google Search grounding
 * stays off: any fact from outside the incident record would be, by this
 * project's rules, a hallucination.
 */
import { GoogleGenAI, ThinkingLevel as GeminiThinking } from "@google/genai";
import { FailoverModel, ModelError, withTimeout, type JsonRequest, type JsonResponse, type ReasoningModel, type ThinkingLevel } from "./model.js";
import type { Embedder } from "./retrieval.js";

/** Flagship reasoning model, then the fastest current Flash as failover. */
export const GEMINI_REASONING_MODEL = "gemini-4-argon";
export const GEMINI_FAST_MODEL = "gemini-3.8-flash";
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

const THINKING: Record<ThinkingLevel, GeminiThinking> = {
  minimal: GeminiThinking.MINIMAL,
  low: GeminiThinking.LOW,
  medium: GeminiThinking.MEDIUM,
  high: GeminiThinking.HIGH,
};

export class GeminiModel implements ReasoningModel {
  constructor(
    private readonly ai: GoogleGenAI,
    readonly id: string,
  ) {}

  async generateJson(req: JsonRequest): Promise<JsonResponse> {
    const response = await withTimeout(this.id, req.timeoutMs, (abortSignal) =>
      this.ai.models
        .generateContent({
          model: this.id,
          contents: [{ role: "user", parts: [{ text: req.prompt }] }],
          config: {
            systemInstruction: req.system,
            responseMimeType: "application/json",
            responseJsonSchema: req.schema,
            thinkingConfig: { thinkingLevel: THINKING[req.thinking] },
            abortSignal,
          },
        })
        .catch((err: unknown) => {
          throw new ModelError(err instanceof Error ? err.message : String(err), "provider_error", this.id);
        }),
    );
    const text = response.text;
    if (!text) throw new ModelError(`${this.id} returned no text`, "empty_response", this.id);
    try {
      return { value: JSON.parse(text), model_id: response.modelVersion ?? this.id };
    } catch {
      throw new ModelError(`${this.id} returned invalid JSON`, "invalid_json", this.id);
    }
  }
}

export class GeminiEmbedder implements Embedder {
  constructor(
    private readonly ai: GoogleGenAI,
    readonly id: string = GEMINI_EMBEDDING_MODEL,
    private readonly timeoutMs = 4000,
  ) {}

  async embed(texts: string[], purpose: "document" | "query"): Promise<number[][]> {
    const response = await withTimeout(this.id, this.timeoutMs, (abortSignal) =>
      this.ai.models.embedContent({
        model: this.id,
        contents: texts,
        config: { taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: 768, abortSignal },
      }),
    );
    return (response.embeddings ?? []).map((e) => e.values ?? []);
  }
}

export interface GeminiAgentModels {
  model: ReasoningModel;
  judge: ReasoningModel;
  embedder: Embedder;
}

/**
 * The production wiring: Argon for answers (Flash as failover), Flash for the
 * per-sentence entailment judge, Gemini embeddings for retrieval.
 *
 * Thinking stays low. Measured on the demo prompt, low thinking answers in
 * 2.5-6 s on either model; medium and high took 11-31 s, too slow for a live
 * call. Grounding comes from the guard and judge, not from longer thinking.
 * Flash does not accept "minimal". Provider latency varies call to call, so
 * the backup is hedged: it starts if the primary has not answered in time.
 */
export function createGeminiModels(apiKey: string): GeminiAgentModels {
  const ai = new GoogleGenAI({ apiKey });
  const reasoning = new GeminiModel(ai, GEMINI_REASONING_MODEL);
  const fast = new GeminiModel(ai, GEMINI_FAST_MODEL);
  return {
    model: new FailoverModel(
      [
        { model: reasoning, thinking: "low", timeoutMs: 10_000 },
        { model: fast, thinking: "low", timeoutMs: 8_000 },
      ],
      { hedgeAfterMs: 5_000 },
    ),
    judge: new FailoverModel(
      [
        { model: fast, thinking: "low", timeoutMs: 7_000 },
        { model: reasoning, thinking: "low", timeoutMs: 9_000 },
      ],
      { hedgeAfterMs: 3_500 },
    ),
    embedder: new GeminiEmbedder(ai),
  };
}
