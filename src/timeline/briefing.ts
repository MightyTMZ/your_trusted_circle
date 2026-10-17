/**
 * Operator briefing: what the voice agent knows about one incident.
 *
 * The agent receives two things:
 *   1. this briefing: state *derived* from the timeline (is anyone
 *      responding? where was the person last seen? how were they moving?)
 *      plus what is unknown;
 *   2. the evidence lines: the timeline events it may cite, as JSONL
 *      (selectEvidence / evidenceToJsonl).
 *
 * Nothing is copied twice: the briefing holds conclusions with a
 * source_event_id each, the evidence holds the events themselves.
 * Consent filtering happens here, in code, so the model never sees data
 * it would have to decide not to disclose.
 */
import { parseIso, toIso } from "../shared/clock.js";
import { serializeEvent } from "./canonical.js";
import { ConsentLedger } from "./consent.js";
import { RESPONDER_SCOPE_FOR } from "./schema/envelope.js";
import { specFor, type EventType, type PayloadOf, type TimelineEvent } from "./schema/catalog.js";

export const BRIEFING_SCHEMA = "ypc.operator_briefing" as const;
export const BRIEFING_VERSION = "2.0" as const;

/** Fixed rules for the voice agent's system prompt; identical for every incident, so not repeated per briefing. */
export const AGENT_DISCLAIMERS = [
  "Identify yourself as an automated assistant. All emergency-service contact in this prototype is simulated.",
  "Motion data are movement observations, not medical conclusions.",
  "Acknowledgment means an alert was received; it does not mean the participant is safe.",
  "Location is last-known only, never live. Say how old it is.",
  "If a fact is not in the briefing or evidence, say it is unknown.",
] as const;

export interface BriefingOptions {
  incidentId: string;
  /** Briefing time in epoch ms, from the injected clock. */
  now: number;
  /** Motion windows older than this are left out of the evidence; the timeline keeps them all. Default 10 min. */
  motionLookbackMs?: number;
}

type Ref = { source_event_id: string };

export interface AlertStatus {
  notification_id: string;
  recipient_id: string;
  recipient_role: PayloadOf<"notification.sent">["recipient_role"];
  escalation_step: number;
  first_sent_at: string;
  attempts: number;
  delivered: boolean;
  viewed: boolean;
  delivery_failed: boolean;
  acknowledged: boolean;
}

export interface OperatorBriefing {
  schema: typeof BRIEFING_SCHEMA;
  schema_version: typeof BRIEFING_VERSION;
  generated_at: string;
  session_id: string;
  incident_id: string;
  participant_id: string;
  /** Head of the hash chain this was built from, so any statement can be audited later. */
  timeline_head_hash: string | null;

  incident: Ref & {
    state: "open" | "acknowledged" | "resolved";
    trigger: PayloadOf<"incident.opened">["trigger"];
    opened_at: string;
    acknowledged: null | (Ref & { at: string; by_role: string; by_id: string });
    resolved: null | (Ref & { at: string; resolution: string; by_role: string; by_id: string });
  };
  /** Self-reported details, only under profile.responders consent. */
  person: {
    status: "shared" | "not_consented" | "not_provided";
    details: null | (Ref & PayloadOf<"profile.shared">);
  };
  location: {
    status: "last_known" | "not_consented" | "not_reported";
    is_current: false;
    last_known: null | (Ref & PayloadOf<"location.reported"> & { age_ms: number });
  };
  motion: {
    baseline: null | (Ref & { features: PayloadOf<"sensor.baseline_calibrated">["features"] });
    /** The most recent anomaly, i.e. why a check-in was sent. */
    observation: null | (Ref & Omit<PayloadOf<"sensor.motion_anomaly_observed">, "rule"> & { rule_id: string });
    latest_window: null | (Ref & {
      window_end: string;
      age_ms: number;
      dynamic_mean_m_s2: number;
      dynamic_peak_m_s2: number;
      stillness_ratio: number;
      coverage_ratio: number;
    });
  };
  device: { status: "online" | "offline" | "unknown"; since: string | null; source_event_id: string | null };
  escalation: {
    pending: (Ref & { step: number; target_role: string; due_at: string })[];
    fired: (Ref & { step: number; target_role: string; at: string })[];
    simulated_emergency_requested: boolean;
  };
  alerts: AlertStatus[];
  /** What the agent must say it does not know. */
  unknowns: string[];
  evidence: {
    /** Timeline events the agent may read and cite, in order. */
    event_ids: string[];
    /** Events withheld for lack of consent; content omitted. */
    redacted: { event_id: string; type: EventType; reason: string }[];
  };
}

export class BriefingError extends Error {
  override name = "BriefingError";
}

const DEFAULT_MOTION_LOOKBACK_MS = 10 * 60_000;
/** A motion window older than this means data stopped arriving. */
const MOTION_STALE_MS = 2 * 60_000;
/** Below this share of expected samples, low movement may just be missing data. */
const MIN_RELIABLE_COVERAGE = 0.8;

export function buildOperatorBriefing(events: readonly TimelineEvent[], opts: BriefingOptions): OperatorBriefing {
  const opened = events.find(
    (e): e is TimelineEvent<"incident.opened"> => e.type === "incident.opened" && e.incident_id === opts.incidentId,
  );
  if (!opened) throw new BriefingError(`Incident ${opts.incidentId} not found in timeline`);
  const subject = opened.participant_id!;
  const now = opts.now;
  const ageOf = (iso: string) => Math.max(0, now - parseIso(iso)!);

  // Consent is evaluated as of now: revoking or leaving withdraws earlier data too.
  const consent = ConsentLedger.from(events.filter((e) => parseIso(e.recorded_at)! <= now));
  const lookbackStart = now - (opts.motionLookbackMs ?? DEFAULT_MOTION_LOOKBACK_MS);

  const evidence: TimelineEvent[] = [];
  const redacted: OperatorBriefing["evidence"]["redacted"] = [];
  for (const e of events) {
    if (parseIso(e.recorded_at)! > now) continue;
    // Only this incident, the subject's own events, and the session's escalation policy. Never other participants.
    const inScope =
      e.incident_id === opts.incidentId ||
      (e.incident_id === null && e.participant_id === subject) ||
      e.type === "session.created";
    if (!inScope) continue;
    if (e.type === "sensor.motion_window" && parseIso(e.occurred_at)! < lookbackStart) continue;
    const sensitivity = specFor(e.type).sensitivity;
    if (sensitivity !== "none" && !consent.has(subject, RESPONDER_SCOPE_FOR[sensitivity])) {
      redacted.push({ event_id: e.event_id, type: e.type, reason: `${RESPONDER_SCOPE_FOR[sensitivity]} not granted` });
      continue;
    }
    evidence.push(e);
  }

  const last = <T extends EventType>(type: T) => evidence.findLast((e): e is TimelineEvent<T> => e.type === type);
  const wasRedacted = (type: EventType) => redacted.some((r) => r.type === type);

  const ack = last("incident.acknowledged");
  const resolved = last("incident.resolved");
  const profile = last("profile.shared");
  const fix = last("location.reported");
  const baseline = last("sensor.baseline_calibrated");
  const anomaly = last("sensor.motion_anomaly_observed");
  const window = last("sensor.motion_window");
  const device = evidence.findLast((e) => e.category === "connectivity" && e.participant_id === subject);

  const briefing: OperatorBriefing = {
    schema: BRIEFING_SCHEMA,
    schema_version: BRIEFING_VERSION,
    generated_at: toIso(now),
    session_id: opened.session_id,
    incident_id: opts.incidentId,
    participant_id: subject,
    timeline_head_hash: events.at(-1)?.hash ?? null,
    incident: {
      state: resolved ? "resolved" : ack ? "acknowledged" : "open",
      trigger: opened.data.trigger,
      opened_at: opened.occurred_at,
      source_event_id: opened.event_id,
      acknowledged: ack
        ? {
            at: ack.occurred_at,
            by_role: ack.data.acknowledged_by_role,
            by_id: ack.data.acknowledged_by_id,
            source_event_id: ack.event_id,
          }
        : null,
      resolved: resolved
        ? {
            at: resolved.occurred_at,
            resolution: resolved.data.resolution,
            by_role: resolved.data.resolved_by_role,
            by_id: resolved.data.resolved_by_id,
            source_event_id: resolved.event_id,
          }
        : null,
    },
    person: {
      status: profile ? "shared" : wasRedacted("profile.shared") ? "not_consented" : "not_provided",
      details: profile ? { ...profile.data, source_event_id: profile.event_id } : null,
    },
    location: {
      status: fix ? "last_known" : wasRedacted("location.reported") ? "not_consented" : "not_reported",
      is_current: false,
      last_known: fix ? { ...fix.data, age_ms: ageOf(fix.data.fix_at), source_event_id: fix.event_id } : null,
    },
    motion: {
      baseline: baseline ? { features: baseline.data.features, source_event_id: baseline.event_id } : null,
      observation: anomaly
        ? (({ rule, ...rest }) => ({ ...rest, rule_id: rule.id, source_event_id: anomaly.event_id }))(anomaly.data)
        : null,
      latest_window: window
        ? {
            window_end: window.data.window_end,
            age_ms: ageOf(window.data.window_end),
            dynamic_mean_m_s2: window.data.dynamic_mean_m_s2,
            dynamic_peak_m_s2: window.data.dynamic_peak_m_s2,
            stillness_ratio: window.data.stillness_ratio,
            coverage_ratio: window.data.coverage_ratio,
            source_event_id: window.event_id,
          }
        : null,
    },
    device: {
      status: !device ? "unknown" : device.type === "connectivity.device_offline" ? "offline" : "online",
      since: device?.occurred_at ?? null,
      source_event_id: device?.event_id ?? null,
    },
    escalation: summarizeEscalation(evidence),
    alerts: summarizeAlerts(evidence),
    unknowns: [],
    evidence: { event_ids: evidence.map((e) => e.event_id), redacted },
  };
  briefing.unknowns = listUnknowns(briefing, evidence);
  return briefing;
}

/** The events the briefing permits, in timeline order. */
export function selectEvidence(events: readonly TimelineEvent[], briefing: OperatorBriefing): TimelineEvent[] {
  const permitted = new Set(briefing.evidence.event_ids);
  return events.filter((e) => permitted.has(e.event_id));
}

/** Evidence as JSONL, ready to hand to the voice model next to the briefing. */
export function evidenceToJsonl(events: readonly TimelineEvent[], briefing: OperatorBriefing): string {
  return selectEvidence(events, briefing)
    .map((e) => `${serializeEvent(e)}\n`)
    .join("");
}

function summarizeEscalation(events: readonly TimelineEvent[]): OperatorBriefing["escalation"] {
  const pending = new Map<string, OperatorBriefing["escalation"]["pending"][number]>();
  const fired: OperatorBriefing["escalation"]["fired"] = [];
  let simulatedEmergency = false;
  for (const e of events) {
    if (e.type === "escalation.step_scheduled") {
      pending.set(`${e.data.escalation_id}:${e.data.step}`, {
        step: e.data.step,
        target_role: e.data.target_role,
        due_at: e.data.due_at,
        source_event_id: e.event_id,
      });
    } else if (e.type === "escalation.step_fired" || e.type === "escalation.step_cancelled") {
      pending.delete(`${e.data.escalation_id}:${e.data.step}`);
      if (e.type === "escalation.step_fired") {
        fired.push({ step: e.data.step, target_role: e.data.target_role, at: e.occurred_at, source_event_id: e.event_id });
      }
    } else if (e.type === "emergency.simulated_dispatch_requested") {
      simulatedEmergency = true;
    }
  }
  return { pending: [...pending.values()], fired, simulated_emergency_requested: simulatedEmergency };
}

function summarizeAlerts(events: readonly TimelineEvent[]): AlertStatus[] {
  const byId = new Map<string, AlertStatus>();
  for (const e of events) {
    if (e.type === "notification.sent") {
      const existing = byId.get(e.data.notification_id);
      if (existing) existing.attempts = Math.max(existing.attempts, e.data.attempt);
      else
        byId.set(e.data.notification_id, {
          notification_id: e.data.notification_id,
          recipient_id: e.data.recipient_id,
          recipient_role: e.data.recipient_role,
          escalation_step: e.data.escalation_step,
          first_sent_at: e.occurred_at,
          attempts: e.data.attempt,
          delivered: false,
          viewed: false,
          delivery_failed: false,
          acknowledged: false,
        });
      continue;
    }
    const status =
      e.type === "notification.delivered" ||
      e.type === "notification.viewed" ||
      e.type === "notification.delivery_failed" ||
      e.type === "incident.acknowledged"
        ? byId.get(e.data.notification_id)
        : undefined;
    if (!status) continue;
    if (e.type === "notification.delivered") status.delivered = true;
    if (e.type === "notification.viewed") status.viewed = true;
    if (e.type === "notification.delivery_failed") status.delivery_failed = true;
    if (e.type === "incident.acknowledged") status.acknowledged = true;
  }
  return [...byId.values()];
}

function listUnknowns(b: OperatorBriefing, evidence: readonly TimelineEvent[]): string[] {
  const unknowns = ["The participant's condition and the cause of the observations are unknown; the system does not diagnose."];

  const loc = b.location;
  if (loc.last_known) unknowns.push(`Current location is unknown; the last fix is from ${loc.last_known.fix_at}.`);
  else if (loc.status === "not_consented") unknowns.push("Location is withheld: the participant has not consented to share it with responders.");
  else unknowns.push("No location has been reported.");

  if (b.person.status === "not_consented") unknowns.push("Name and personal details are withheld: the participant has not consented to share them.");
  else if (!b.person.details?.display_name) unknowns.push("The participant's name has not been provided.");

  const w = b.motion.latest_window;
  if (!w) unknowns.push("No recent motion data is available.");
  else if (w.age_ms > MOTION_STALE_MS) unknowns.push(`No motion data has arrived since ${w.window_end}.`);
  else if (w.coverage_ratio < MIN_RELIABLE_COVERAGE) {
    unknowns.push(`The latest motion window has only ${Math.round(w.coverage_ratio * 100)}% of expected samples; low movement may be missing data.`);
  }

  if (b.device.status === "offline") unknowns.push(`The device has been offline since ${b.device.since}.`);
  if (!evidence.some((e) => e.type === "checkin.responded")) unknowns.push("The participant has not answered a check-in.");
  if (b.incident.state === "open") unknowns.push("No responder has acknowledged the alert.");
  return unknowns;
}
