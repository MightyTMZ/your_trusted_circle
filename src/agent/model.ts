/**
 * Provider-neutral model interface. The agent depends on this, not on a
 * vendor SDK, so tests use scripted fakes and the provider can change.
 * gemini.ts implements it; keys stay in the server process that builds it.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface JsonRequest {
  /** Fixed rules. Operator speech never goes here. */
  system: string;
  /** Fact sheet, transcript, and the quoted operator turn. */
  prompt: string;
  /** JSON Schema the response must follow (enforced by the provider where supported). */
  schema: object;
  thinking: ThinkingLevel;
  timeoutMs: number;
}

export interface JsonResponse {
  value: unknown;
  /** The model that actually answered (after any failover). */
  model_id: string;
}

export interface ReasoningModel {
  readonly id: string;
  generateJson(req: JsonRequest): Promise<JsonResponse>;
}

export class ModelError extends Error {
  override name = "ModelError";
  constructor(
    message: string,
    readonly code: "timeout" | "provider_error" | "invalid_json" | "empty_response",
    readonly model_id: string,
  ) {
    super(message);
  }
}

/** Rejects with a ModelError("timeout") and aborts the signal if work takes longer than ms. */
export async function withTimeout<T>(modelId: string, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelError(`${modelId} did not answer within ${ms} ms`, "timeout", modelId));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries each model in order; the first valid JSON answer wins. Each entry
 * may override thinking level and timeout (a fast fallback should think less).
 */
export class FailoverModel implements ReasoningModel {
  readonly id: string;

  constructor(private readonly chain: { model: ReasoningModel; thinking?: ThinkingLevel; timeoutMs?: number }[]) {
    if (chain.length === 0) throw new Error("FailoverModel needs at least one model");
    this.id = chain.map((c) => c.model.id).join(" -> ");
  }

  async generateJson(req: JsonRequest): Promise<JsonResponse> {
    const errors: string[] = [];
    let code: ModelError["code"] = "provider_error";
    for (const { model, thinking, timeoutMs } of this.chain) {
      try {
        return await model.generateJson({ ...req, thinking: thinking ?? req.thinking, timeoutMs: timeoutMs ?? req.timeoutMs });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        code = err instanceof ModelError ? err.code : "provider_error";
      }
    }
    throw new ModelError(`all models failed: ${errors.join(" | ")}`, code, this.chain.at(-1)!.model.id);
  }
}
