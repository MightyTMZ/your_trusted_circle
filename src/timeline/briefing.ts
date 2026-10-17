/**
 * Operator briefing: the read model the voice agent drafts its speech from.
 *
 * Built only from timeline events. Every fact cites its source event_id
 * and timestamp; location and profile data appear only under the
 * participant's current consent; gaps are listed in `unknowns` so the
 * agent states them instead of guessing.
 */
import { parseIso, toIso } from "../shared/clock.js";
import { RESPONDER_SCOPE_FOR, type ConsentScope } from "./schema/envelope.js";
import { specFor, type Category, type EventType, type PayloadOf, type TimelineEvent } from "./schema/catalog.js";

export const BRIEFING_SCHEMA = "ypc.operator_briefing" as const;
export const BRIEFING_VERSION = "1.0" as const;

export interface BriefingOptions {
  incidentId: string;
  /** Briefing time in epoch ms, from the injected clock. */
  now: number;
}

export interface GroundedFact {
  event_id: string;
  seq: number;
  occurred_at: string;
  /** How long before the briefing this happened. */
  age_ms: number;
  type: EventType;
  category: Category;
  /** Deterministic summary of the event; safe to paraphrase, never to embellish. */
  statement: string;
  simulated: boolean;
}

export interface Redaction {
  event_id: string;
  type: EventType;
  reason: string;
}

export interface NotificationStatus {
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
  source_event_ids: string[];
}

export interface OperatorBriefing {
  schema: typeof BRIEFING_SCHEMA;
  schema_version: typeof BRIEFING_VERSION;
  generated_at: string;
  session_id: string;
  incident_id: string;
  participant_id: string;
  /** Head of the hash chain the briefing was built from, for audit. */
  timeline_head_hash: string | null;
  incident: {
    state: "open" | "acknowledged" | "resolved";
    opened_at: string;
    trigger: PayloadOf<"incident.opened">["trigger"];
    acknowledged: null | { at: string; by_role: string; by_id: string; event_id: string };
    resolved: null | { at: string; resolution: string; by_role: string; by_id: string; event_id: string };
    source_event_id: string;
  };
  participant: {
    participant_id: string;
    profile_status: "shared" | "not_consented" | "not_provided";
    profile: null | (PayloadOf<"profile.shared"> & { source_event_id: string; shared_at: string });
  };
  location: {
    status: "last_known" | "not_consented" | "not_reported";
    /** Always false: the system never has a live location, only the most recent fix. */
    is_current: false;
    last_known: null | (PayloadOf<"location.reported"> & { age_ms: number; source_event_id: string });
  };
  device: {
    status: "online" | "offline" | "unknown";
    since: string | null;
    source_event_id: string | null;
  };
  escalation: {
    pending_steps: { escalation_id: string; step: number; target_role: string; due_at: string; source_event_id: string }[];
    fired_steps: { step: number; target_role: string; fired_at: string; source_event_id: string }[];
    simulated_emergency_requested: boolean;
  };
  notifications: NotificationStatus[];
  facts: GroundedFact[];
  redactions: Redaction[];
  unknowns: string[];
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Automated assistant. All emergency-service contact in this prototype is simulated.",
  "Motion anomalies are movement observations, not medical conclusions.",
  "Acknowledgment confirms an alert was received; it does not indicate the participant is safe.",
  "Location is last-known only, never live.",
];

export class BriefingError extends Error {
  override name = "BriefingError";
}

export function buildOperatorBriefing(events: readonly TimelineEvent[], opts: BriefingOptions): OperatorBriefing {
  const opened = events.find(
    (e): e is TimelineEvent<"incident.opened"> => e.type === "incident.opened" && e.incident_id === opts.incidentId,
  );
  if (!opened) throw new BriefingError(`Incident ${opts.incidentId} not found in timeline`);
  const subject = opened.participant_id!;
  const consent = consentAt(events, subject);

  const relevant = events.filter(
    (e) =>
      parseIso(e.recorded_at)! <= opts.now &&
      (e.incident_id === opts.incidentId ||
        (e.incident_id === null && e.participant_id === subject) ||
        e.type === "session.created"),
  );

  const facts: GroundedFact[] = [];
  const redactions: Redaction[] = [];
  for (const e of relevant) {
    const sensitivity = specFor(e.type).sensitivity;
    if (sensitivity !== "none" && !consent.has(RESPONDER_SCOPE_FOR[sensitivity])) {
      redactions.push({
        event_id: e.event_id,
        type: e.type,
        reason: `participant has not granted ${RESPONDER_SCOPE_FOR[sensitivity]}`,
      });
      continue;
    }
    facts.push({
      event_id: e.event_id,
      seq: e.seq,
      occurred_at: e.occurred_at,
      age_ms: Math.max(0, opts.now - parseIso(e.occurred_at)!),
      type: e.type,
      category: e.category,
      statement: e.summary,
      simulated: e.provenance.simulated,
    });
  }

  const disclosed = new Set(facts.map((f) => f.event_id));
  const visible = relevant.filter((e) => disclosed.has(e.event_id));
  const lastOf = <T extends EventType>(type: T) =>
    visible.findLast((e): e is TimelineEvent<T> => e.type === type);

  const ack = lastOf("incident.acknowledged");
  const resolved = lastOf("incident.resolved");
  const profileEvent = lastOf("profile.shared");
  const fix = lastOf("location.reported");
  const device = visible.findLast(
    (e) => e.type === "connectivity.device_offline" || e.type === "connectivity.device_online",
  );

  const briefing: OperatorBriefing = {
    schema: BRIEFING_SCHEMA,
    schema_version: BRIEFING_VERSION,
    generated_at: toIso(opts.now),
    session_id: opened.session_id,
    incident_id: opts.incidentId,
    participant_id: subject,
    timeline_head_hash: events.at(-1)?.hash ?? null,
    incident: {
      state: resolved ? "resolved" : ack ? "acknowledged" : "open",
      opened_at: opened.occurred_at,
      trigger: opened.data.trigger,
      acknowledged: ack
        ? {
            at: ack.occurred_at,
            by_role: ack.data.acknowledged_by_role,
            by_id: ack.data.acknowledged_by_id,
            event_id: ack.event_id,
          }
        : null,
      resolved: resolved
        ? {
            at: resolved.occurred_at,
            resolution: resolved.data.resolution,
            by_role: resolved.data.resolved_by_role,
            by_id: resolved.data.resolved_by_id,
            event_id: resolved.event_id,
          }
        : null,
      source_event_id: opened.event_id,
    },
    participant: {
      participant_id: subject,
      profile_status: profileEvent ? "shared" : redactions.some((r) => r.type === "profile.shared") ? "not_consented" : "not_provided",
      profile: profileEvent ? { ...profileEvent.data, source_event_id: profileEvent.event_id, shared_at: profileEvent.occurred_at } : null,
    },
    location: {
      status: fix ? "last_known" : redactions.some((r) => r.type === "location.reported") ? "not_consented" : "not_reported",
      is_current: false,
      last_known: fix
        ? { ...fix.data, age_ms: Math.max(0, opts.now - parseIso(fix.data.fix_at)!), source_event_id: fix.event_id }
        : null,
    },
    device: {
      status: !device ? "unknown" : device.type === "connectivity.device_offline" ? "offline" : "online",
      since: device ? device.occurred_at : null,
      source_event_id: device ? device.event_id : null,
    },
    escalation: summarizeEscalation(visible),
    notifications: summarizeNotifications(visible),
    facts,
    redactions,
    unknowns: [],
    disclaimers: [...DISCLAIMERS],
  };
  briefing.unknowns = listUnknowns(briefing, visible);
  return briefing;
}

/** Facts as JSONL, one cited statement per line, for feeding to the voice model. */
export function factsToJsonl(briefing: OperatorBriefing): string {
  return briefing.facts.map((f) => `${JSON.stringify(f)}\n`).join("");
}

/** Scopes currently granted by the participant. Leaving the session withdraws all of them. */
function consentAt(events: readonly TimelineEvent[], participantId: string): Set<ConsentScope> {
  const scopes = new Set<ConsentScope>();
  for (const e of events) {
    if (e.participant_id !== participantId) continue;
    if (e.type === "consent.granted") e.data.scopes.forEach((s) => scopes.add(s));
    if (e.type === "consent.revoked") e.data.scopes.forEach((s) => scopes.delete(s));
    if (e.type === "session.participant_left") scopes.clear();
  }
  return scopes;
}

function summarizeEscalation(events: readonly TimelineEvent[]): OperatorBriefing["escalation"] {
  const pending = new Map<string, OperatorBriefing["escalation"]["pending_steps"][number]>();
  const fired: OperatorBriefing["escalation"]["fired_steps"] = [];
  let simulatedEmergency = false;
  for (const e of events) {
    if (e.type === "escalation.step_scheduled") {
      pending.set(`${e.data.escalation_id}:${e.data.step}`, {
        escalation_id: e.data.escalation_id,
        step: e.data.step,
        target_role: e.data.target_role,
        due_at: e.data.due_at,
        source_event_id: e.event_id,
      });
    } else if (e.type === "escalation.step_fired") {
      pending.delete(`${e.data.escalation_id}:${e.data.step}`);
      fired.push({ step: e.data.step, target_role: e.data.target_role, fired_at: e.occurred_at, source_event_id: e.event_id });
    } else if (e.type === "escalation.step_cancelled") {
      pending.delete(`${e.data.escalation_id}:${e.data.step}`);
    } else if (e.type === "emergency.simulated_dispatch_requested") {
      simulatedEmergency = true;
    }
  }
  return { pending_steps: [...pending.values()], fired_steps: fired, simulated_emergency_requested: simulatedEmergency };
}

function summarizeNotifications(events: readonly TimelineEvent[]): NotificationStatus[] {
  const byId = new Map<string, NotificationStatus>();
  for (const e of events) {
    if (e.type === "notification.sent") {
      const existing = byId.get(e.data.notification_id);
      if (existing) {
        existing.attempts = Math.max(existing.attempts, e.data.attempt);
        existing.source_event_ids.push(e.event_id);
      } else {
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
          source_event_ids: [e.event_id],
        });
      }
      continue;
    }
    const id =
      e.type === "notification.delivered" ||
      e.type === "notification.viewed" ||
      e.type === "notification.delivery_failed" ||
      e.type === "incident.acknowledged"
        ? e.data.notification_id
        : null;
    const status = id ? byId.get(id) : undefined;
    if (!status) continue;
    status.source_event_ids.push(e.event_id);
    if (e.type === "notification.delivered") status.delivered = true;
    if (e.type === "notification.viewed") status.viewed = true;
    if (e.type === "notification.delivery_failed") status.delivery_failed = true;
    if (e.type === "incident.acknowledged") status.acknowledged = true;
  }
  return [...byId.values()];
}

function listUnknowns(b: OperatorBriefing, events: readonly TimelineEvent[]): string[] {
  const unknowns = [
    "The participant's medical condition and the cause of the observations are unknown; the system does not diagnose.",
  ];
  if (b.location.status === "last_known") {
    unknowns.push(`Current location is unknown; the last-known fix is from ${b.location.last_known!.fix_at}.`);
  } else if (b.location.status === "not_consented") {
    unknowns.push("Location is not available: the participant has not consented to share it with responders.");
  } else {
    unknowns.push("No location has been reported.");
  }
  if (b.participant.profile_status === "not_consented") {
    unknowns.push("Profile details (such as name) are not available: the participant has not consented to share them.");
  } else if (b.participant.profile_status === "not_provided") {
    unknowns.push("The participant has not provided a name or emergency notes.");
  } else if (!b.participant.profile?.display_name) {
    unknowns.push("The participant's name has not been provided.");
  }
  if (b.device.status === "offline") {
    unknowns.push(`The participant's device has been offline since ${b.device.since}; nothing after that is known from the device.`);
  }
  const lastResponse = events.findLast((e) => e.type === "checkin.responded");
  if (!lastResponse) unknowns.push("The participant has not answered any check-in.");
  if (b.incident.state !== "resolved" && !b.notifications.some((n) => n.acknowledged)) {
    unknowns.push("No responder has acknowledged the alert yet.");
  }
  return unknowns;
}
