/**
 * Live simulated calls. A practice call gets its own copy of the synthetic
 * no-response incident, restored onto a clock that moves with real time; a
 * demo call (ring) reads the live demo incident's own timeline. Each call
 * has one OperatorCallAgent. The person at the operator console plays the
 * mock operator; nothing here can reach a real one.
 *
 * Speech is a transport detail: the operator's audio is transcribed, then
 * handled exactly like typed text; the agent's audio is synthesized only
 * from the text of an agent turn already logged in the timeline.
 */
import type { Clock } from "../../shared/clock.js";
import { SequentialIds, type IdGenerator } from "../../shared/ids.js";
import { OperatorCallAgent, type AgentReply, type AgentStage, type CallAgentOptions } from "../../agent/agent.js";
import type { Embedder } from "../../agent/retrieval.js";
import type { ReasoningModel } from "../../agent/model.js";
import type { Fact } from "../../agent/facts.js";
import { FIXTURE_INCIDENT_ID, buildNoResponseScenario } from "../../timeline/fixtures/no-response.js";
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import { Timeline } from "../../timeline/timeline.js";
import { GEMINI_FAST_MODEL, GEMINI_REASONING_MODEL, createGeminiModels } from "../../agent/gemini.js";
import { ElevenLabsSpeech, type SpeechProvider } from "./elevenlabs.js";
import type { CallView, CapabilitiesResponse, FactView, IncomingCall, ReplyView, TurnResponse } from "./protocol.js";

export class CallError extends Error {
  override name = "CallError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface CallServiceOptions {
  models?: { model: ReasoningModel; judge: ReasoningModel; embedder?: Embedder };
  /** Shown to the console: which models answer. */
  reasoningId?: string;
  speech?: SpeechProvider;
  /** Calls kept at once; the oldest ended or idle call is dropped first. Default 8. */
  maxCalls?: number;
  /** A call with no activity for this long is ended. Default 30 min. */
  idleMs?: number;
  /** Monotonic milliseconds. Tests pass a fake. */
  wallClock?: () => number;
  /** Agent overrides (timeouts in tests). */
  agent?: Partial<Pick<CallAgentOptions, "answerTimeoutMs" | "judgeTimeoutMs" | "maxAttempts" | "maxSilencePrompts">>;
}

interface LiveCall {
  id: string;
  agent: OperatorCallAgent;
  timeline: Timeline;
  incidentId: string;
  /** Set for a call placed by escalation that nobody has answered yet. */
  ringing: { since: string; about: string } | null;
  /** What the agent is doing while it prepares an answer (agent.ts onStage). */
  activity: CallView["activity"];
  lastActive: number;
}

/** What escalation hands over when it places a call: the incident's own timeline and clock. */
export interface RingRequest {
  timeline: Timeline;
  clock: Clock;
  incidentId: string;
  /** Shown on the incoming-call card. Only a name the person shared with responders, else a neutral label. */
  about: string;
  timeZone: string;
  scenarioId: string;
}

const OPERATOR_AUDIO_LIMIT = 5 * 1024 * 1024;

export class CallService {
  private readonly calls = new Map<string, LiveCall>();
  private readonly callIds = new SequentialIds();
  private readonly wall: () => number;

  constructor(private readonly opts: CallServiceOptions = {}) {
    this.wall = opts.wallClock ?? (() => performance.now());
  }

  capabilities(): CapabilitiesResponse {
    return {
      reasoning: this.opts.models ? (this.opts.reasoningId ?? "configured") : null,
      speech_to_text: this.opts.speech?.sttId ?? null,
      text_to_speech: this.opts.speech?.ttsId ?? null,
    };
  }

  /** Builds a fresh incident, places the simulated call, and speaks the opening breakdown. */
  start(): { call: CallView; reply: ReplyView } {
    this.evict();
    const scenario = buildNoResponseScenario({ voiceCall: false });
    // The story's clock stops at the simulated dispatch; from here it follows real time.
    const base = scenario.clock.now();
    const t0 = this.wall();
    const clock: Clock = { now: () => base + Math.max(0, Math.round(this.wall() - t0)) };
    const timeline = Timeline.restore(scenario.timeline.events, {
      sessionId: scenario.timeline.sessionId,
      clock,
      ids: continuingIds(scenario.timeline.events.length),
    });
    const id = this.callIds.next("call");
    const holder: { live?: LiveCall } = {};
    const agent = new OperatorCallAgent({
      onStage: this.tracker(holder, clock),
      timeline,
      clock,
      incidentId: FIXTURE_INCIDENT_ID,
      callId: id,
      // The synthetic story is told in UTC.
      timeZone: "UTC",
      dataOrigin: "synthetic_scenario",
      scenarioId: "night-out-v3",
      ...this.opts.models,
      ...this.opts.agent,
    });
    const live: LiveCall = { id, agent, timeline, incidentId: FIXTURE_INCIDENT_ID, ringing: null, activity: null, lastActive: this.wall() };
    holder.live = live;
    this.calls.set(id, live);
    const started = this.wall();
    const reply = agent.start();
    return { call: this.view(live), reply: this.replyView(live, reply, started) };
  }

  /**
   * Places a call about a live incident. It rings until someone at the operator
   * console answers; only then does the agent speak. The agent reads and
   * appends to the incident's own timeline, so it sees events that arrive
   * during the call (an acknowledgment, say).
   */
  ring(req: RingRequest): string {
    this.evict();
    const id = this.callIds.next("call");
    const holder: { live?: LiveCall } = {};
    const agent = new OperatorCallAgent({
      onStage: this.tracker(holder, req.clock),
      timeline: req.timeline,
      clock: req.clock,
      incidentId: req.incidentId,
      callId: id,
      timeZone: req.timeZone,
      dataOrigin: "synthetic_scenario",
      scenarioId: req.scenarioId,
      ...this.opts.models,
      ...this.opts.agent,
    });
    const live: LiveCall = {
      id,
      agent,
      timeline: req.timeline,
      incidentId: req.incidentId,
      ringing: { since: new Date(req.clock.now()).toISOString(), about: req.about },
      activity: null,
      lastActive: this.wall(),
    };
    holder.live = live;
    this.calls.set(id, live);
    return id;
  }

  /** Calls placed by escalation that are waiting for the operator, oldest first. */
  incoming(): IncomingCall[] {
    return [...this.calls.values()]
      .filter((c) => c.ringing !== null)
      .map((c) => ({ call_id: c.id, incident_id: c.incidentId, ringing_since: c.ringing!.since, about: c.ringing!.about }))
      .sort((a, b) => a.ringing_since.localeCompare(b.ringing_since));
  }

  /** The operator picks up: the agent starts and speaks the opening breakdown. */
  answer(callId: string): { call: CallView; reply: ReplyView } {
    const live = this.get(callId);
    if (!live.ringing) throw new CallError(`Call ${callId} is not ringing.`, 409);
    live.ringing = null;
    live.lastActive = this.wall();
    const started = this.wall();
    const reply = live.agent.start();
    return { call: this.view(live), reply: this.replyView(live, reply, started) };
  }

  /** The current state of a call, for the escalation that placed it. */
  status(callId: string): CallView["status"] | null {
    const live = this.calls.get(callId);
    return live ? this.statusOf(live) : null;
  }

  /** One operator turn, as text. */
  async operatorText(callId: string, text: string): Promise<TurnResponse> {
    const live = this.active(callId);
    if (!text.trim()) throw new CallError("Say or type something first.", 400);
    const started = this.wall();
    const reply = await live.agent.respond(text);
    live.lastActive = this.wall();
    return { operator_text: text.trim(), reply: reply && this.replyView(live, reply, started), call: this.view(live) };
  }

  /** One operator turn, as recorded audio: transcribed, then handled like text. */
  async operatorSpeech(callId: string, audio: Uint8Array, mimeType: string): Promise<TurnResponse> {
    this.active(callId);
    if (!this.opts.speech) throw new CallError("Speech-to-text is not configured; type the question instead.", 503);
    if (audio.byteLength === 0) throw new CallError("No audio received.", 400);
    if (audio.byteLength > OPERATOR_AUDIO_LIMIT) throw new CallError("Recording too long.", 413);
    const text = await this.opts.speech.transcribe(audio, mimeType);
    if (!text) throw new CallError("No speech was recognized. Try again, a little closer to the microphone.", 422);
    return this.operatorText(callId, text);
  }

  /** The operator has said nothing for durationMs: the agent prompts once, then ends the call. */
  silence(callId: string, durationMs: number): { reply: ReplyView; call: CallView } {
    const live = this.active(callId);
    const started = this.wall();
    const reply = live.agent.silence(clampMs(durationMs));
    live.lastActive = this.wall();
    return { reply: this.replyView(live, reply, started), call: this.view(live) };
  }

  /** The operator spoke over agent turn turnIndex after heardMs of its audio. */
  interrupt(callId: string, turnIndex: number, heardMs: number): { call: CallView } {
    const live = this.active(callId);
    try {
      live.agent.interrupted(turnIndex, clampMs(heardMs));
    } catch (err) {
      throw new CallError(err instanceof Error ? err.message : String(err), 400);
    }
    return { call: this.view(live) };
  }

  end(callId: string): { call: CallView } {
    const live = this.get(callId);
    // Declining a ringing call still logs that it ended, with no call started.
    live.ringing = null;
    live.agent.end("operator_hangup");
    return { call: this.view(live) };
  }

  state(callId: string): { call: CallView } {
    return { call: this.view(this.get(callId)) };
  }

  /** The text of an agent turn already in the timeline: the only text the voice will ever read. */
  agentTurnText(callId: string, turnIndex: number): string {
    const turn = this.get(callId).timeline.events.find(
      (e): e is TimelineEvent<"voice.utterance"> =>
        e.type === "voice.utterance" && e.data.call_id === callId && e.data.turn_index === turnIndex && e.data.speaker === "voice_agent",
    );
    if (!turn) throw new CallError(`No agent turn ${turnIndex} on ${callId}.`, 404);
    return turn.data.text;
  }

  get speech(): SpeechProvider | undefined {
    return this.opts.speech;
  }

  private get(callId: string): LiveCall {
    const live = this.calls.get(callId);
    if (!live) throw new CallError(`No call ${callId}.`, 404);
    return live;
  }

  private active(callId: string): LiveCall {
    const live = this.get(callId);
    if (live.ringing) throw new CallError(`Call ${callId} has not been answered yet.`, 409);
    if (!live.agent.isActive) throw new CallError(`Call ${callId} has ended.`, 409);
    return live;
  }

  /** Ends idle calls and keeps at most maxCalls, dropping ended ones first. */
  private evict(): void {
    const now = this.wall();
    for (const live of this.calls.values()) {
      if ((live.agent.isActive || live.ringing) && now - live.lastActive > (this.opts.idleMs ?? 30 * 60_000)) {
        live.ringing = null;
        live.agent.end("timeout");
      }
    }
    const max = this.opts.maxCalls ?? 8;
    const open = (c: LiveCall) => Number(c.agent.isActive || c.ringing !== null);
    const byAge = [...this.calls.values()].sort((a, b) => open(a) - open(b) || a.lastActive - b.lastActive);
    while (this.calls.size >= max && byAge.length) {
      const drop = byAge.shift()!;
      drop.ringing = null;
      drop.agent.end("disconnected");
      this.calls.delete(drop.id);
    }
  }

  private replyView(live: LiveCall, reply: AgentReply, startedAt: number): ReplyView {
    return {
      turn_index: reply.turn_index,
      text: reply.text,
      path: reply.path,
      model_id: reply.model_id,
      retrieval_mode: reply.retrieval_mode,
      fact_ids: reply.fact_ids,
      facts: reply.facts.map(factView),
      grounding_event_ids: reply.grounding_event_ids,
      rejected: reply.rejected,
      latency_ms: Math.round(this.wall() - startedAt),
      audio_url: this.opts.speech ? `/api/calls/${live.id}/turns/${reply.turn_index}/audio` : null,
    };
  }

  private view(live: LiveCall): CallView {
    const events = live.timeline.events;
    const mine = events.filter((e) => e.type.startsWith("voice.") && (e.data as { call_id?: string }).call_id === live.id);
    const cut = new Map(
      mine
        .filter((e): e is TimelineEvent<"voice.agent_interrupted"> => e.type === "voice.agent_interrupted")
        .map((e) => [e.data.turn_index, e.data.heard_ms]),
    );
    const ended = mine.find((e): e is TimelineEvent<"voice.call_ended"> => e.type === "voice.call_ended");
    return {
      call_id: live.id,
      incident_id: live.incidentId,
      status: this.statusOf(live),
      ended_reason: ended?.data.reason ?? null,
      transcript: mine
        .filter((e): e is TimelineEvent<"voice.utterance"> => e.type === "voice.utterance")
        .map((e) => ({
          turn_index: e.data.turn_index,
          speaker: e.data.speaker,
          text: e.data.text,
          at: e.occurred_at,
          ...(cut.has(e.data.turn_index) ? { interrupted_after_ms: cut.get(e.data.turn_index)! } : {}),
        })),
      facts: live.agent.factSheet().facts.map(factView),
      log: mine.map((e) => ({ event_id: e.event_id, type: e.type, at: e.occurred_at, summary: e.summary })),
      timeline_events: events.length,
      rejected_drafts: mine.filter((e) => e.type === "voice.draft_rejected").length,
      activity: live.activity,
    };
  }

  /** Records the agent's current step on its call, for the console's live view. */
  private tracker(holder: { live?: LiveCall }, clock: Clock): (stage: AgentStage, attempt: number) => void {
    return (stage, attempt) => {
      if (!holder.live) return;
      holder.live.activity = stage === "idle" ? null : { stage, attempt, since: new Date(clock.now()).toISOString() };
    };
  }

  private statusOf(live: LiveCall): CallView["status"] {
    return live.ringing ? "ringing" : live.agent.isActive ? "active" : "ended";
  }
}

/**
 * The production wiring, from the server's environment: Gemini when
 * GEMINI_API_KEY is set (else facts are read verbatim), ElevenLabs when
 * ELEVENLABS_API_KEY is set (else text only). Keys stay in this process.
 */
export function createCallService(env: NodeJS.ProcessEnv): CallService {
  const gemini = env.GEMINI_API_KEY?.trim();
  const eleven = env.ELEVENLABS_API_KEY?.trim();
  return new CallService({
    ...(gemini ? { models: createGeminiModels(gemini), reasoningId: `${GEMINI_REASONING_MODEL} -> ${GEMINI_FAST_MODEL}` } : {}),
    ...(eleven ? { speech: new ElevenLabsSpeech({ apiKey: eleven, voiceId: env.ELEVENLABS_VOICE_ID?.trim() }) } : {}),
  });
}

function factView(f: Fact): FactView {
  return { id: f.id, topic: f.topic, kind: f.kind, text: f.text, source_event_ids: f.source_event_ids };
}

/** Continues evt_NNNN numbering after the restored fixture events. */
function continuingIds(existing: number): IdGenerator {
  const ids = new SequentialIds();
  for (let i = 0; i < existing; i++) ids.next("evt");
  return ids;
}

function clampMs(ms: number): number {
  return Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), 60 * 60_000) : 0;
}
