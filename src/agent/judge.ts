/**
 * Entailment judge: the second, model-based check. A separate model call
 * sees each sentence with only the facts it cites and must say whether those
 * facts fully entail it. Partial support counts as a failure. Anything the
 * judge does not explicitly mark "supported" is treated as unsupported.
 */
import { v, validate } from "../timeline/schema/validate.js";
import type { Fact } from "./facts.js";
import type { ReasoningModel } from "./model.js";
import { JUDGE_RESPONSE_SCHEMA, JUDGE_SYSTEM_INSTRUCTION, buildJudgePrompt } from "./prompt.js";

export type Verdict = "supported" | "partial" | "unsupported";

export interface JudgedSentence {
  text: string;
  verdict: Verdict;
  reason: string;
}

export interface JudgeResult {
  ok: boolean;
  model_id: string;
  sentences: JudgedSentence[];
}

const judgeSchema = v.object({
  verdicts: v.array(
    v.object({
      claim: v.number({ min: 1, integer: true }),
      verdict: v.enum(["supported", "partial", "unsupported"] as const),
      reason: v.string({ maxLength: 500 }),
    }),
  ),
});

export async function judgeSentences(
  judge: ReasoningModel,
  claims: readonly { text: string; facts: readonly Fact[] }[],
  timeoutMs: number,
): Promise<JudgeResult> {
  const { value, model_id } = await judge.generateJson({
    system: JUDGE_SYSTEM_INSTRUCTION,
    prompt: buildJudgePrompt(claims),
    schema: JUDGE_RESPONSE_SCHEMA,
    thinking: "low",
    timeoutMs,
  });
  const issues = validate(judgeSchema, value);
  const verdicts = issues.length ? [] : (value as { verdicts: { claim: number; verdict: Verdict; reason: string }[] }).verdicts;
  const sentences = claims.map((c, i) => {
    const found = verdicts.filter((x) => x.claim === i + 1);
    // Missing, duplicated, or malformed verdicts fail closed.
    if (found.length !== 1) {
      return { text: c.text, verdict: "unsupported" as const, reason: issues.length ? "judge returned malformed output" : "judge gave no single verdict" };
    }
    return { text: c.text, verdict: found[0]!.verdict, reason: found[0]!.reason };
  });
  return { ok: sentences.every((s) => s.verdict === "supported"), model_id, sentences };
}
