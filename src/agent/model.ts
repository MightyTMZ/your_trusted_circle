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
 *
 * With hedgeAfterMs, the next model also starts if the current one has not
 * answered by then, so one slow provider call costs a few seconds, not its
 * whole timeout. Losing calls run until their own timeout and are ignored.
 */
export class FailoverModel implements ReasoningModel {
  readonly id: string;

  constructor(
    private readonly chain: { model: ReasoningModel; thinking?: ThinkingLevel; timeoutMs?: number }[],
    private readonly opts: { hedgeAfterMs?: number } = {},
  ) {
    if (chain.length === 0) throw new Error("FailoverModel needs at least one model");
    this.id = chain.map((c) => c.model.id).join(" -> ");
  }

  generateJson(req: JsonRequest): Promise<JsonResponse> {
    return new Promise((resolve, reject) => {
      const errors: string[] = [];
      let code: ModelError["code"] = "provider_error";
      let started = 0;
      let failed = 0;
      let done = false;
      let hedge: ReturnType<typeof setTimeout> | undefined;
      const launch = () => {
        clearTimeout(hedge);
        if (done || started >= this.chain.length) return;
        const i = started++;
        if (this.opts.hedgeAfterMs !== undefined && started < this.chain.length) hedge = setTimeout(launch, this.opts.hedgeAfterMs);
        const { model, thinking, timeoutMs } = this.chain[i]!;
        model.generateJson({ ...req, thinking: thinking ?? req.thinking, timeoutMs: timeoutMs ?? req.timeoutMs }).then(
          (response) => {
            if (done) return;
            done = true;
            clearTimeout(hedge);
            resolve(response);
          },
          (err: unknown) => {
            errors[i] = err instanceof Error ? err.message : String(err);
            code = err instanceof ModelError ? err.code : "provider_error";
            if (done) return;
            if (++failed === this.chain.length) {
              done = true;
              reject(new ModelError(`all models failed: ${errors.join(" | ")}`, code, this.chain.at(-1)!.model.id));
            } else {
              launch();
            }
          },
        );
      };
      launch();
    });
  }
}
