/**
 * Retrieval over the fact sheet (the "R" in RAG).
 *
 * Hybrid: BM25 over each fact's text, topic and operator-vocabulary keywords,
 * plus dense similarity from an injected embedder (Gemini embeddings in
 * production), fused with reciprocal rank fusion. If the embedder fails or
 * is absent, lexical ranking is used alone.
 *
 * Retrieval only decides what the model looks at first and what the
 * deterministic fallback says. The whole fact sheet is always in the prompt,
 * so a retrieval miss can never hide a fact or invite the model to fill a gap.
 */
import type { Fact } from "./facts.js";

export interface Embedder {
  readonly id: string;
  /** One vector per text. "document" for facts, "query" for operator speech. */
  embed(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
}

export interface RetrievedFact {
  fact: Fact;
  /** Reciprocal-rank-fusion score; higher is more relevant. */
  score: number;
  lexical_score: number;
  dense_similarity: number | null;
}

export interface RetrievalResult {
  ranked: RetrievedFact[];
  /** "hybrid" when dense scores were used, otherwise "lexical". */
  mode: "hybrid" | "lexical";
  dense_error: string | null;
}

/** A fact counts as relevant for the deterministic fallback above these. */
const MIN_LEXICAL = 0.5;
const MIN_DENSE = 0.62;
const RELATIVE_CUTOFF = 0.6;
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const STOPWORDS = new Set(
  // "emergency" is in nearly every operator sentence, so it carries no signal.
  "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them they this to was we were what when which who will with would you your there then any not no yes just about also emergency".split(
    " ",
  ),
);

/** Lowercase word tokens with light suffix stripping, so "breathing" matches "breath". */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t)).map(stem);
}

function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export class FactRetriever {
  /** Embeddings survive across fact-sheet rebuilds; facts are re-worded rarely. */
  private readonly vectors = new Map<string, number[]>();

  constructor(private readonly embedder?: Embedder) {}

  async retrieve(facts: readonly Fact[], query: string, k: number): Promise<RetrievalResult> {
    const lexical = bm25(facts, tokenize(query));
    let dense: number[] | null = null;
    let denseError: string | null = null;
    if (this.embedder && query.trim()) {
      try {
        dense = await this.denseScores(facts, query);
      } catch (err) {
        denseError = err instanceof Error ? err.message : String(err);
      }
    }

    const lexRank = rankOf(lexical);
    const denseRank = dense ? rankOf(dense) : null;
    const ranked = facts
      .map((fact, i) => ({
        fact,
        lexical_score: lexical[i]!,
        dense_similarity: dense ? dense[i]! : null,
        score:
          (lexical[i]! > 0 ? 1 / (RRF_K + lexRank[i]!) : 0) +
          (denseRank && dense![i]! > 0 ? 1 / (RRF_K + denseRank[i]!) : 0),
      }))
      .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id, undefined, { numeric: true }))
      .slice(0, k);
    return { ranked, mode: dense ? "hybrid" : "lexical", dense_error: denseError };
  }

  private async denseScores(facts: readonly Fact[], query: string): Promise<number[]> {
    const missing = facts.map((f) => f.text).filter((t) => !this.vectors.has(t));
    if (missing.length) {
      const vecs = await this.embedder!.embed(missing, "document");
      if (vecs.length !== missing.length) throw new Error("embedder returned the wrong number of vectors");
      missing.forEach((t, i) => this.vectors.set(t, vecs[i]!));
    }
    const [q] = await this.embedder!.embed([query], "query");
    if (!q) throw new Error("embedder returned no query vector");
    return facts.map((f) => cosine(q, this.vectors.get(f.text)!));
  }
}

/** Facts relevant enough for the fallback to speak: clear matches, and none far weaker than the best. */
export function relevantFacts(result: RetrievalResult): Fact[] {
  const topLexical = Math.max(0, ...result.ranked.map((r) => r.lexical_score));
  const minLexical = Math.max(MIN_LEXICAL, topLexical * RELATIVE_CUTOFF);
  return result.ranked
    .filter((r) => r.lexical_score >= minLexical || (r.dense_similarity ?? 0) >= MIN_DENSE)
    .map((r) => r.fact);
}

function bm25(facts: readonly Fact[], query: string[]): number[] {
  // Field weighting: topic and operator-vocabulary keywords count twice, so
  // "address" finds the location fact even where body text mentions "emergency".
  const docs = facts.map((f) => {
    const field = tokenize(`${f.topic.replace("_", " ")} ${f.keywords.join(" ")}`);
    return [...tokenize(f.text), ...field, ...field];
  });
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const terms = [...new Set(query)];
  return docs.map((d) => {
    let score = 0;
    for (const t of terms) {
      const tf = d.filter((x) => x === t).length;
      if (!tf) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avg));
    }
    return score;
  });
}

/** 1-based rank of each score, ties broken by index. */
function rankOf(scores: number[]): number[] {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const ranks = new Array<number>(scores.length);
  order.forEach(([, i], r) => (ranks[i] = r + 1));
  return ranks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
