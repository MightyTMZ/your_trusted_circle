/**
 * Voice-agent adapter: one simulated call to the mock operator.
 *
 * Each operator turn runs this pipeline:
 *
 *   rebuild briefing at clock.now ─► fact sheet ─► hybrid retrieval
 *     ─► reasoning model (JSON: sentences + cited fact IDs)
 *     ─► schema check ─► deterministic guard ─► entailment judge
 *     ─► pass: speak the draft
 *        fail: one repair attempt with the problems listed, then
 *              the deterministic fallback (relevant facts, verbatim)
 *
 * Nothing reaches the speaker unless every sentence cites facts that exist
 * and survives both checks; the fallback speaks only fact text, which code
 * wrote from the timeline. Every spoken turn, rejected draft and model
 * error is appended to the timeline. Fails closed: if the judge cannot run,
 * the draft is not spoken.
 *
 * The only endpoint is the in-process mock operator. Nothing here can place
 * a call.
 */
import type { Clock } from "../shared/clock.js";
import { buildOperatorBriefing, selectEvidence } from "../timeline/briefing.js";
import { MOCK_OPERATOR_ENDPOINT_ID, type DataOrigin } from "../timeline/schema/envelope.js";
import type { PayloadOf, TimelineEvent } from "../timeline/schema/catalog.js";
import type { Timeline } from "../timeline/timeline.js";
import { buildFactSheet, type Fact, type FactSheet } from "./facts.js";
import { checkDraft, draftText, parseDraft, type Draft } from "./guard.js";
import { judgeSentences } from "./judge.js";
import { ModelError, type ReasoningModel, type ThinkingLevel } from "./model.js";
import { ANSWER_RESPONSE_SCHEMA, ANSWER_SYSTEM_INSTRUCTION, buildAnswerPrompt, type TranscriptTurn } from "./prompt.js";
import { FactRetriever, relevantFacts, type Embedder } from "./retrieval.js";

export const AGENT_PRODUCER = "ytc-voice-agent@0.1.0";
const MAX_OPERATOR_CHARS = 1000;
const TRANSCRIPT_TURNS = 12;
const FALLBACK_FACTS = 2;
/**
 * Requests for other people's data or to change the agent's rules. The model
 * is told to decline these; the fallback must not answer them with whatever
 * facts happen to match. (The data is not on the sheet either way.)
 */
const OUT_OF_SCOPE =
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|rules?|prompt)\b|\b(system prompt|jailbreak|developer mode|role-?play|pretend)\b|\b(everyone|everybody|all (the )?(people|participants|members|users)|other (people|participants|members|users)|whole group|the group)\b/i;

export interface CallAgentOptions {
  timeline: Timeline;
  clock: Clock;
  incidentId: string;
  callId: string;
  /** IANA zone for spoken times. */
  timeZone: string;
  /** Without a model the agent answers only with the deterministic fallback. */
  model?: ReasoningModel;
  /** Without a judge only the deterministic guard checks drafts. */
  judge?: ReasoningModel;
  embedder?: Embedder;
  dataOrigin?: DataOrigin;
  scenarioId?: string;
  retrievalK?: number;
  /** Drafts per turn: the first plus repairs. Default 2. */
  maxAttempts?: number;
  thinking?: ThinkingLevel;
  answerTimeoutMs?: number;
  judgeTimeoutMs?: number;
  /** Silence prompts before the agent ends the call. Default 1. */
  maxSilencePrompts?: number;
  /** Told as each step of an answer starts, so a console can show what the agent is doing. */
  onStage?: (stage: AgentStage, attempt: number) => void;
}

/** The steps of one answer, in order. "fallback": reading facts verbatim because no draft passed. */
export type AgentStage = "reading_record" | "finding_facts" | "drafting" | "checking" | "verifying" | "fallback" | "idle";

export type ReplyPath = "model" | "model_repaired" | "fallback" | "scripted";

export interface Rejection {
  attempt: number;
  stage: PayloadOf<"voice.draft_rejected">["stage"];
  reasons: string[];
}

export interface AgentReply {
  turn_index: number;
  text: string;
  fact_ids: string[];
  grounding_event_ids: string[];
  path: ReplyPath;
  model_id: string | null;
  retrieval_mode: "hybrid" | "lexical" | null;
  rejected: Rejection[];
  utterance_event_id: string;
  /** The facts the reply cites, as they read when it was spoken. */
  facts: Fact[];
}

interface Spoken {
  text: string;
  facts: Fact[];
  /** Extra grounding for scripted lines that are about the call itself. */
  events?: string[];
}

export class OperatorCallAgent {
  private readonly retriever: FactRetriever;
  private nextTurn: number;
  private generation = 0;
  private silenceStreak = 0;
  private ended: boolean;

  constructor(private readonly opts: CallAgentOptions) {
    this.retriever = new FactRetriever(opts.embedder);
    const turns = this.callEvents("voice.utterance").map((e) => e.data.turn_index);
    this.nextTurn = turns.length ? Math.max(...turns) + 1 : 0;
    this.ended = this.callEvents("voice.call_ended").length > 0;
  }

  get isActive(): boolean {
    return !this.ended && this.callStarted() !== undefined;
  }

  /** Starts the call (once) and speaks the scripted opening. */
  start(): AgentReply {
    if (this.callStarted()) throw new Error(`call ${this.opts.callId} has already started`);
    const dispatch = this.opts.timeline.events.findLast(
      (e) => e.type === "emergency.simulated_dispatch_requested" && e.incident_id === this.opts.incidentId,
    );
    const started = this.append("voice.call_started", "voice_agent", { call_id: this.opts.callId, mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID }, dispatch ? [dispatch.event_id] : []);
    // The opening is the full breakdown, read from the facts verbatim: who, why, what the
    // phone recorded, where, their own note, and who has (not) responded. No model call.
    const sheet = this.sheet();
    const pick = (topic: Fact["topic"]) => sheet.facts.find((f) => f.topic === topic);
    const breakdown = [
      pick("identity"),
      pick("incident"),
      sheet.facts.find((f) => f.topic === "motion" && f.headline),
      pick("location"),
      pick("notes"),
      sheet.facts.filter((f) => f.topic === "alerts").at(-1),
    ];
    const opening: Spoken[] = [
      { text: "Hello, this is an automated assistant from the YTC group safety app, not a person, and this is a simulated call.", facts: [], events: [started.event_id] },
      ...breakdown.filter((f): f is Fact => !!f).map((f) => ({ text: f.text, facts: [f] })),
      { text: "I can only share what is in the app's record, and I will tell you when something is unknown. What would you like to know?", facts: [], events: [started.event_id] },
    ];
    return this.speak(opening, "scripted", null, null, []);
  }

  /** Logs what the operator said and answers it. Returns null if a newer turn superseded this one. */
  async respond(operatorText: string): Promise<AgentReply | null> {
    this.assertActive();
    const text = sanitize(operatorText);
    if (!text) return null;
    const operatorTurn = this.nextTurn++;
    this.append("voice.utterance", "mock_operator", {
      call_id: this.opts.callId,
      turn_index: operatorTurn,
      speaker: "mock_operator",
      text,
      grounding_event_ids: [],
      interrupted: false,
    });
    return this.answer(text, operatorTurn);
  }

  /** Answers the latest operator turn already in the timeline (e.g. after a restart). */
  async answerLatest(): Promise<AgentReply | null> {
    this.assertActive();
    const last = this.callEvents("voice.utterance").at(-1);
    if (!last || last.data.speaker !== "mock_operator") return null;
    return this.answer(last.data.text, last.data.turn_index);
  }

  /** The operator has been silent for durationMs. */
  silence(durationMs: number): AgentReply {
    this.assertActive();
    const silent = this.append("voice.silence_detected", "system", { call_id: this.opts.callId, duration_ms: Math.round(durationMs) });
    this.silenceStreak++;
    if (this.silenceStreak <= (this.opts.maxSilencePrompts ?? 1)) {
      return this.speak(
        [{ text: "Are you still there? I can repeat the last-known location and what the app recorded.", facts: [], events: [silent.event_id] }],
        "scripted",
        null,
        null,
        [],
      );
    }
    const sheet = this.sheet();
    const incident = sheet.facts.find((f) => f.topic === "incident")!;
    const resolved = this.opts.timeline.events.some((e) => e.type === "incident.resolved" && e.incident_id === this.opts.incidentId);
    const reply = this.speak(
      [
        { text: "I have not heard a response, so I am ending this simulated call.", facts: [], events: [silent.event_id] },
        { text: resolved ? "The alert has been marked resolved in the app." : "The alert has not been resolved in the app.", facts: [incident] },
      ],
      "scripted",
      null,
      null,
      [],
    );
    this.end("timeout");
    return reply;
  }

  /** The operator spoke over agent turn turnIndex after heardMs of its audio played. Logged once per turn. */
  interrupted(turnIndex: number, heardMs: number): void {
    this.assertActive();
    const turn = this.callEvents("voice.utterance").find((e) => e.data.turn_index === turnIndex && e.data.speaker === "voice_agent");
    if (!turn) throw new Error(`turn ${turnIndex} is not an agent turn on call ${this.opts.callId}`);
    if (this.interruptedTurns().has(turnIndex)) return;
    this.append("voice.agent_interrupted", "mock_operator", { call_id: this.opts.callId, turn_index: turnIndex, heard_ms: Math.max(0, Math.round(heardMs)) }, [turn.event_id]);
  }

  /** The fact sheet as of now: what the agent may say. */
  factSheet(): FactSheet {
    return this.sheet();
  }

  end(reason: PayloadOf<"voice.call_ended">["reason"]): void {
    if (this.ended) return;
    const started = this.callStarted();
    const duration = started ? Math.max(0, this.opts.clock.now() - Date.parse(started.occurred_at)) : 0;
    this.append("voice.call_ended", "voice_agent", { call_id: this.opts.callId, reason, duration_ms: duration });
    this.ended = true;
  }

  // ── Pipeline ──────────────────────────────────────────────────────────

  private async answer(operatorText: string, operatorTurn: number): Promise<AgentReply | null> {
    this.silenceStreak = 0;
    const ticket = ++this.generation;
    try {
      return await this.answerSteps(operatorText, operatorTurn, ticket);
    } finally {
      if (ticket === this.generation) this.opts.onStage?.("idle", 0);
    }
  }

  private async answerSteps(operatorText: string, operatorTurn: number, ticket: number): Promise<AgentReply | null> {
    const stage = (name: AgentStage, attempt = 0) => {
      if (ticket === this.generation) this.opts.onStage?.(name, attempt);
    };
    stage("reading_record");
    const sheet = this.sheet();
    stage("finding_facts");
    const retrieval = await this.retriever.retrieve(sheet.facts, operatorText, this.opts.retrievalK ?? 6);
    const focus = retrieval.ranked.filter((r) => r.score > 0).map((r) => r.fact);
    const rejected: Rejection[] = [];
    const reject = (attempt: number, stage: Rejection["stage"], reasons: string[], draft?: string, modelId?: string) => {
      const r = { attempt, stage, reasons: reasons.slice(0, 12).map((x) => x.slice(0, 300)) };
      rejected.push(r);
      this.append("voice.draft_rejected", "voice_agent", {
        call_id: this.opts.callId,
        turn_index: operatorTurn,
        attempt,
        stage,
        reasons: r.reasons,
        ...(draft ? { draft_text: draft.slice(0, 2000) } : {}),
        ...(modelId ? { model_id: modelId.slice(0, 80) } : {}),
      });
    };

    let accepted: { draft: Draft; model_id: string; attempt: number } | null = null;
    if (this.opts.model) {
      let repair: { draft: string; problems: string[] } | undefined;
      const maxAttempts = this.opts.maxAttempts ?? 2;
      for (let attempt = 1; attempt <= maxAttempts && !accepted; attempt++) {
        let response;
        stage("drafting", attempt);
        try {
          response = await this.opts.model.generateJson({
            system: ANSWER_SYSTEM_INSTRUCTION,
            prompt: buildAnswerPrompt({ sheet, focus, transcript: this.transcript(), operatorText, repair }),
            schema: ANSWER_RESPONSE_SCHEMA,
            thinking: this.opts.thinking ?? "low",
            timeoutMs: this.opts.answerTimeoutMs ?? 15_000,
          });
        } catch (err) {
          this.logError(err, "model");
          break;
        }
        const parsed = parseDraft(response.value);
        if (!parsed.draft) {
          const raw = JSON.stringify(response.value) ?? "";
          reject(attempt, "schema", parsed.issues, raw || undefined, response.model_id);
          repair = { draft: raw, problems: parsed.issues };
          continue;
        }
        const spokenText = draftText(parsed.draft);
        stage("checking", attempt);
        const guard = checkDraft(parsed.draft, sheet);
        if (!guard.ok) {
          reject(attempt, "guard", guard.violations, spokenText, response.model_id);
          repair = { draft: spokenText, problems: guard.violations };
          continue;
        }
        if (this.opts.judge) {
          const byId = new Map(sheet.facts.map((f) => [f.id, f]));
          let verdict;
          stage("verifying", attempt);
          try {
            verdict = await judgeSentences(
              this.opts.judge,
              parsed.draft.sentences.map((s) => ({ text: s.text, facts: s.fact_ids.map((id) => byId.get(id)!) })),
              this.opts.judgeTimeoutMs ?? 8_000,
            );
          } catch (err) {
            // Fail closed: an unchecked draft is never spoken.
            reject(attempt, "judge_unavailable", [message(err)], spokenText, response.model_id);
            this.logError(err, "judge");
            break;
          }
          if (!verdict.ok) {
            const problems = verdict.sentences
              .filter((s) => s.verdict !== "supported")
              .map((s) => `${JSON.stringify(s.text)} is ${s.verdict}: ${s.reason}`);
            reject(attempt, "judge", problems, spokenText, verdict.model_id);
            repair = { draft: spokenText, problems };
            continue;
          }
        }
        accepted = { draft: parsed.draft, model_id: response.model_id, attempt };
      }
    }

    if (ticket !== this.generation) {
      // The operator spoke again while this turn was being prepared; the newer turn answers.
      if (accepted) reject(accepted.attempt, "superseded", ["a newer operator turn arrived first"], draftText(accepted.draft), accepted.model_id);
      return null;
    }

    if (accepted) {
      const byId = new Map(sheet.facts.map((f) => [f.id, f]));
      return this.speak(
        accepted.draft.sentences.map((s) => ({ text: s.text.trim(), facts: s.fact_ids.map((id) => byId.get(id)!) })),
        accepted.attempt === 1 ? "model" : "model_repaired",
        accepted.model_id,
        retrieval.mode,
        rejected,
      );
    }
    stage("fallback");
    const relevant = OUT_OF_SCOPE.test(operatorText) ? [] : relevantFacts(retrieval);
    return this.speak(this.fallback(sheet, relevant), "fallback", null, retrieval.mode, rejected);
  }

  /** Relevant facts, verbatim; or the scope fact when nothing on the sheet matches or the request is out of scope. */
  private fallback(sheet: FactSheet, relevant: Fact[]): Spoken[] {
    const chosen = relevant.filter((f) => f.topic !== "scope").slice(0, FALLBACK_FACTS);
    const facts = chosen.length ? chosen : [sheet.facts.find((f) => f.topic === "scope")!];
    return facts.map((f) => ({ text: f.text, facts: [f] }));
  }

  // ── Timeline ──────────────────────────────────────────────────────────

  private speak(parts: Spoken[], path: ReplyPath, modelId: string | null, retrievalMode: AgentReply["retrieval_mode"], rejected: Rejection[]): AgentReply {
    const text = parts.map((p) => p.text).join(" ");
    const fact_ids = [...new Set(parts.flatMap((p) => p.facts.map((f) => f.id)))];
    const grounding = [...new Set(parts.flatMap((p) => [...p.facts.flatMap((f) => f.source_event_ids), ...(p.events ?? [])]))];
    const known = new Set(this.opts.timeline.events.map((e) => e.event_id));
    const unknown = grounding.filter((id) => !known.has(id));
    if (grounding.length === 0 || unknown.length) {
      throw new Error(`refusing to speak an ungrounded line (missing: ${unknown.join(", ") || "all"})`);
    }
    const turn = this.nextTurn++;
    const event = this.append(
      "voice.utterance",
      "voice_agent",
      { call_id: this.opts.callId, turn_index: turn, speaker: "voice_agent", text: text.slice(0, 2000), grounding_event_ids: grounding, interrupted: false },
      [],
      modelId ? `${AGENT_PRODUCER}/${modelId}` : AGENT_PRODUCER,
    );
    const facts = [...new Map(parts.flatMap((p) => p.facts).map((f) => [f.id, f])).values()];
    return { turn_index: turn, text, fact_ids, grounding_event_ids: grounding, path, model_id: modelId, retrieval_mode: retrievalMode, rejected, utterance_event_id: event.event_id, facts };
  }

  private logError(err: unknown, source: "model" | "judge"): void {
    const code = err instanceof ModelError ? err.code : "unexpected";
    this.append("voice.agent_error", "voice_agent", { call_id: this.opts.callId, error_code: `${source}_${code}`, recoverable: true });
  }

  private append<
    T extends "voice.call_started" | "voice.utterance" | "voice.silence_detected" | "voice.agent_interrupted" | "voice.draft_rejected" | "voice.agent_error" | "voice.call_ended",
  >(
    type: T,
    actor: "voice_agent" | "mock_operator" | "system",
    data: PayloadOf<T>,
    causedBy: string[] = [],
    producer = AGENT_PRODUCER,
  ): TimelineEvent<T> {
    const subject = this.opts.timeline.events.find((e) => e.type === "incident.opened" && e.incident_id === this.opts.incidentId)?.participant_id ?? null;
    return this.opts.timeline.append({
      type,
      data,
      incident_id: this.opts.incidentId,
      participant_id: subject,
      actor: { kind: actor, id: null },
      provenance: {
        component: "voice_agent",
        data_origin: this.opts.dataOrigin ?? "system_generated",
        simulated: true,
        producer: producer.slice(0, 80),
        ...(this.opts.scenarioId ? { scenario_id: this.opts.scenarioId } : {}),
      },
      caused_by: causedBy,
    });
  }

  private sheet(): FactSheet {
    const events = this.opts.timeline.events;
    const briefing = buildOperatorBriefing(events, { incidentId: this.opts.incidentId, now: this.opts.clock.now() });
    return buildFactSheet(briefing, selectEvidence(events, briefing), { timeZone: this.opts.timeZone });
  }

  /** Recent turns for the prompt. A cut-off agent turn says so: the operator may not have heard the rest. */
  private transcript(): TranscriptTurn[] {
    const cut = this.interruptedTurns();
    return this.callEvents("voice.utterance")
      .slice(-TRANSCRIPT_TURNS)
      .map((e) => ({
        speaker: e.data.speaker,
        text: cut.has(e.data.turn_index) ? `${e.data.text} [cut off: the operator interrupted and may not have heard all of this]` : e.data.text,
      }));
  }

  private interruptedTurns(): Set<number> {
    return new Set(
      this.opts.timeline.events
        .filter((e): e is TimelineEvent<"voice.agent_interrupted"> => e.type === "voice.agent_interrupted" && e.data.call_id === this.opts.callId)
        .map((e) => e.data.turn_index),
    );
  }

  private callEvents<T extends "voice.utterance" | "voice.call_ended" | "voice.call_started">(type: T): TimelineEvent<T>[] {
    return this.opts.timeline.events.filter(
      (e): e is TimelineEvent<T> => e.type === type && (e.data as { call_id: string }).call_id === this.opts.callId,
    );
  }

  private callStarted(): TimelineEvent<"voice.call_started"> | undefined {
    return this.callEvents("voice.call_started")[0];
  }

  private assertActive(): void {
    if (!this.isActive) throw new Error(`call ${this.opts.callId} is not active`);
  }
}

/** Control characters out, whitespace collapsed, length capped. */
function sanitize(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_OPERATOR_CHARS);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
