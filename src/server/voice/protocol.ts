/**
 * Wire types for the simulated-call API, shared by the server routes and the
 * operator console. Types only: nothing here may import Node or browser APIs.
 */

export interface FactView {
  id: string;
  topic: string;
  kind: "observed" | "derived" | "unknown" | "policy";
  text: string;
  /** Timeline events the fact rests on. */
  source_event_ids: string[];
}

export interface ReplyView {
  turn_index: number;
  text: string;
  path: "model" | "model_repaired" | "fallback" | "scripted";
  model_id: string | null;
  retrieval_mode: "hybrid" | "lexical" | null;
  fact_ids: string[];
  /** The cited facts as they read when the reply was spoken. */
  facts: FactView[];
  grounding_event_ids: string[];
  /** Drafts that failed a check and were never spoken. */
  rejected: { attempt: number; stage: string; reasons: string[] }[];
  latency_ms: number;
  /** Speech for this turn, or null when no voice provider is configured. */
  audio_url: string | null;
}

export interface TurnView {
  turn_index: number;
  speaker: "voice_agent" | "mock_operator";
  text: string;
  at: string;
  /** Set when the operator spoke over this agent turn. */
  interrupted_after_ms?: number;
}

export interface LogLine {
  event_id: string;
  type: string;
  at: string;
  summary: string;
}

export interface CallView {
  call_id: string;
  incident_id: string;
  /** "ringing": placed by escalation, not answered yet; the agent has said nothing. */
  status: "ringing" | "active" | "ended";
  ended_reason: string | null;
  transcript: TurnView[];
  /** The fact sheet as of now: everything the agent may say. */
  facts: FactView[];
  /** This call's voice events, oldest first. */
  log: LogLine[];
  timeline_events: number;
  rejected_drafts: number;
  /** What the agent is doing right now, while it prepares an answer; null when it is not. */
  activity: { stage: "reading_record" | "finding_facts" | "drafting" | "checking" | "verifying" | "fallback"; attempt: number; since: string } | null;
}

/** A call placed by escalation, waiting for someone at the operator console. */
export interface IncomingCall {
  call_id: string;
  incident_id: string;
  ringing_since: string;
  /** The person's name if they shared it with responders, else a neutral label. */
  about: string;
}

export interface StartCallResponse {
  call: CallView;
  reply: ReplyView;
}

export interface TurnResponse {
  /** What the server heard (the transcript, for speech). */
  operator_text: string;
  /** Null when a newer operator turn superseded this one. */
  reply: ReplyView | null;
  call: CallView;
}

export interface CallUpdateResponse {
  reply: ReplyView | null;
  call: CallView;
}

export interface CapabilitiesResponse {
  /** Gemini reasoning, judge and embeddings; without it the agent speaks facts verbatim. */
  reasoning: string | null;
  speech_to_text: string | null;
  text_to_speech: string | null;
}

/** One recorded operator turn. JSON like every other request (the API accepts JSON only). */
export interface SpeechRequest {
  audio_base64: string;
  mime_type: string;
}

/** The backend's one error shape (src/server/context.ts). */
export interface ErrorResponse {
  error: { code: string; message: string };
}
