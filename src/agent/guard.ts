/**
 * Deterministic grounding guard: the first, model-independent check on every
 * draft before anything can be spoken.
 *
 * A draft is a list of sentences, each citing fact IDs. A sentence fails if:
 *   - it cites no fact, or a fact that is not on the sheet;
 *   - it contains a number, time, or number word not present in the facts it cites;
 *   - it uses a capitalized name or place that is not in the facts it cites;
 *   - it uses a condition, cause, or safety term (unconscious, drugged,
 *     safe, fell, ...) that is not in the facts it cites;
 *   - it contains an internal ID, URI, email address, or long digit run.
 *
 * Passing the guard is necessary, not sufficient: "they are breathing" cites
 * the condition-unknown fact, which contains "breathing". The entailment
 * judge (judge.ts) catches that.
 */
import { v, validate, type Infer } from "../timeline/schema/validate.js";
import type { Fact, FactSheet } from "./facts.js";

export const MAX_SENTENCES = 4;
const MAX_SENTENCE_CHARS = 400;

export const draftSchema = v.object({
  intent: v.enum(["answer", "unknown", "clarify", "decline"] as const),
  sentences: v.array(
    v.object({
      text: v.string({ minLength: 1, maxLength: MAX_SENTENCE_CHARS }),
      fact_ids: v.array(v.string({ pattern: /^F\d+$/ }), { minLength: 1, maxLength: 6 }),
    }),
    { minLength: 1, maxLength: MAX_SENTENCES },
  ),
});
export type Draft = Infer<typeof draftSchema>;

export interface SentenceCheck {
  text: string;
  fact_ids: string[];
  violations: string[];
}

export interface GuardResult {
  ok: boolean;
  sentences: SentenceCheck[];
  violations: string[];
}

export function parseDraft(raw: unknown): { draft: Draft; issues: [] } | { draft: null; issues: string[] } {
  const issues = validate(draftSchema, raw);
  if (issues.length) return { draft: null, issues: issues.map((i) => `${i.path || "(draft)"}: ${i.message}`) };
  return { draft: raw as Draft, issues: [] };
}

/** "one" is left out: "no one" and "the one" are not counts. */
const NUMBER_WORDS =
  "zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million dozen".split(
    " ",
  );

/**
 * Terms that assert a condition, cause, or safety status. Each must appear in
 * a cited fact (where it is, by construction, framed as unknown or quoted).
 */
const RISKY_STEMS = [
  "conscious", "unconscious", "breath", "pulse", "heart", "injur", "bleed", "hurt", "wound", "broken",
  "drug", "spike", "drunk", "intoxica", "alcohol", "overdos", "poison", "seizure", "faint", "passed out",
  // copy-guard: allow (denylist of words drafts may not use)
  "collaps", "fell", "fall", "trip", "slip", "assault", "attack", "kidnap", "abduct", "dead", "die", "alive",
  "safe", "unsafe", "okay", "fine", "stable", "asleep", "sleep", "diagnos", "medical",
  "currently", "right now", "live location", "on the way", "en route", "arriv", "ambulance", "police",
  "still at", "still there", "remain", "drink", "wearing",
  "boyfriend", "girlfriend", "partner", "husband", "wife", "friend", "brother", "sister", "mother", "father", "parent", "roommate",
  "north", "south", "east", "west",
];

/** Gendered pronouns are allowed only if the participant shared them; otherwise "they". */
const GENDERED_PRONOUNS = ["she", "her", "hers", "herself", "he", "him", "his", "himself"];

/** A sentence citing only unknown facts must say so, not turn the gap into a claim. */
const UNCERTAINTY =
  /\b(unknown|not|no|nobody|none|never|cannot|unable|without|whether|unclear|unsure|neither|nor)\b|n't\b/i;

const ALLOWED_CAPITALIZED = new Set(["I", "I'm", "I've", "I'll", "OK", "AM", "PM", "YTC", "GPS"]);

/** Speakable form of a draft, for logging and repair prompts. */
export function draftText(draft: Draft): string {
  return draft.sentences.map((s) => s.text.trim()).join(" ");
}

export function checkDraft(draft: Draft, sheet: FactSheet): GuardResult {
  const byId = new Map(sheet.facts.map((f) => [f.id, f]));
  const sentences = draft.sentences.map((s) => checkSentence(s.text, s.fact_ids, byId));
  const violations = sentences.flatMap((s, i) => s.violations.map((v) => `sentence ${i + 1}: ${v}`));
  return { ok: violations.length === 0, sentences, violations };
}

export function checkSentence(text: string, factIds: string[], byId: ReadonlyMap<string, Fact>): SentenceCheck {
  const violations: string[] = [];
  const cited: Fact[] = [];
  for (const id of factIds) {
    const f = byId.get(id);
    if (f) cited.push(f);
    else violations.push(`cites ${id}, which is not on the fact sheet`);
  }
  if (factIds.length === 0) violations.push("cites no fact");
  const source = cited.map((f) => f.text).join(" \n ");
  const sourceLower = normalize(source).toLowerCase();
  const sourceNumbers = new Set(numbersIn(source));
  const t = normalize(text);

  for (const n of numbersIn(t)) {
    // "11:50" may shorten a cited "11:50:30"; nothing else may differ.
    const ok = sourceNumbers.has(n) || [...sourceNumbers].some((s) => s.startsWith(`${n}:`));
    if (!ok) violations.push(`number "${n}" is not in the cited facts`);
  }
  for (const w of words(t)) {
    if (NUMBER_WORDS.includes(w.toLowerCase()) && !hasWord(sourceLower, w.toLowerCase())) {
      violations.push(`number word "${w}" is not in the cited facts`);
    }
  }
  for (const stemText of RISKY_STEMS) {
    const re = new RegExp(`\\b${stemText}`, "i");
    if (re.test(t) && !re.test(sourceLower)) violations.push(`"${stemText}…" is not supported by the cited facts`);
  }
  const shared = sharedPronouns(byId);
  for (const p of GENDERED_PRONOUNS) {
    if (hasWord(t.toLowerCase(), p) && !shared.includes(p)) {
      violations.push(`uses "${p}", but the participant has not shared those pronouns (say "they")`);
    }
  }
  // A detail that exists elsewhere on the sheet but not in the cited facts was
  // borrowed from the wrong fact ("near the bar" citing a later fix).
  const citedWords = new Set(contentWords(sourceLower));
  const elsewhere = new Set([...byId.values()].filter((f) => !cited.includes(f)).flatMap((f) => contentWords(normalize(f.text).toLowerCase())));
  for (const w of new Set(contentWords(t.toLowerCase()))) {
    if (!citedWords.has(w) && elsewhere.has(w) && !GENERIC_WORDS.has(w)) {
      violations.push(`"${w}" comes from a fact this sentence does not cite`);
    }
  }
  if (cited.length > 0 && cited.every((f) => f.kind === "unknown") && !UNCERTAINTY.test(t)) {
    violations.push("cites only unknown facts but states something as known");
  }
  for (const name of capitalizedTerms(t)) {
    if (!ALLOWED_CAPITALIZED.has(name) && !sourceLower.includes(name.toLowerCase())) {
      violations.push(`name or place "${name}" is not in the cited facts`);
    }
  }
  if (/\b(evt|par|con|ntf|inc|ses|chk|esc|call|rec)_[a-z0-9]+/i.test(t)) violations.push("contains an internal ID");
  if (/\b[a-z][a-z0-9+.-]*:\/?\/?[^\s,]/i.test(t.replace(/\b\d{1,2}:\d{2}/g, ""))) violations.push("contains a URI");
  if (/\S+@\S+\.\S+/.test(t)) violations.push("contains an email address");
  if (/\d[\d\s().-]{6,}\d/.test(t) && !source.includes(t.match(/\d[\d\s().-]{6,}\d/)![0])) {
    violations.push("contains a phone-number-like digit run");
  }
  if (t.length > MAX_SENTENCE_CHARS) violations.push("sentence is too long");
  return { text, fact_ids: factIds, violations };
}

/** Words common to many facts; using one without citing a fact that contains it says nothing new. */
const GENERIC_WORDS = new Set(
  "app phone participant alert record recorded information share shared know unknown time about their they them there this that with from have been were what when which while also whether since until after before because between during later only just more most then than into over under each every other some such does doesn't didn't don't isn't could would should will might must being like same sure even ever including include seen the and are was not has had for but its who how why can may yet all any one two out per via did get got let own you new now off way see saw yes our".split(
    " ",
  ),
);

/** Lowercase words of three or more letters ("bar" counts). Hyphens split words: "last-known" is "last", "known". */
function contentWords(lower: string): string[] {
  return lower.match(/[a-z][a-z']{2,}/g) ?? [];
}

/** Pronoun words the participant shared, e.g. ["she", "her"], from the identity fact anywhere on the sheet. */
function sharedPronouns(byId: ReadonlyMap<string, Fact>): string[] {
  for (const f of byId.values()) {
    const m = f.topic === "identity" ? /Their pronouns are ([^.]+)\./.exec(f.text) : null;
    if (m) return m[1]!.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  }
  return [];
}

/** Straight quotes, plain spaces, and "m/s2" spelled consistently. */
function normalize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[  ]/g, " ");
}

/** Numbers as written, including times (11:50:30), decimals (153.6) and signs (-79.3957). */
function numbersIn(s: string): string[] {
  return (s.match(/-?\d+(?:[.:,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]$/, ""));
}

function words(s: string): string[] {
  return s.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
}

function hasWord(haystack: string, w: string): boolean {
  return new RegExp(`\\b${w}\\b`).test(haystack);
}

/** Ordinary words that start a sentence; any other sentence-initial word is checked like a name. */
const SENTENCE_STARTERS = new Set(
  "a an the they their them it its this that these those there here i i'm i've i'll we our you your yes no nobody none not at in on from between after before since as by for to of with without about around when while if whether and but so also however unfortunately sorry hello hi please okay currently recorded last earlier my she he her his".split(
    " ",
  ),
);

/** Capitalized words, including sentence-initial ones that are not ordinary starters: likely names and places. */
function capitalizedTerms(s: string): string[] {
  const out: string[] = [];
  const parts = s.split(/(?<=[.!?:;"])\s+/);
  for (const part of parts) {
    const ws = part.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
    ws.forEach((w, i) => {
      if (!/^[A-Z]/.test(w)) return;
      if (i === 0 && SENTENCE_STARTERS.has(w.toLowerCase())) return;
      out.push(w);
    });
  }
  return out;
}
