/**
 * One function per server action, each appending the matching catalog event
 * to the session timeline (timeline/record.ts). Kept apart from the routes so
 * the mapping from server state to catalog payloads is in one place.
 *
 * Mappings worth knowing:
 * - Consent: sharing with "group" grants location.group; sharing with "host"
 *   or with responders grants location.responders (the host is the first
 *   responder); monitoring grants monitoring.
 * - Recipient ids: the host by participant id, a backup contact by con_ id,
 *   and the simulated emergency step as "emergency_service_sim".
 */
import { MOCK_OPERATOR_ENDPOINT_ID, type ConsentScope } from "../../timeline/schema/envelope.js";
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import type { Deps } from "../context.js";
import type { CheckInDoc, EscalationLevel, IncidentDoc, NotificationJobDoc, ParticipantConsent, ParticipantDoc, Recipient, SessionDoc } from "../types.js";
import { prov } from "./record.js";

export const CONSENT_TEXT_VERSIONS = ["consent-v1"] as const;
/** Repeats allowed per escalation step, recorded in session.created. */
export const MAX_REPEATS = 2;

export function consentScopes(c: ParticipantConsent): ConsentScope[] {
  const scopes: ConsentScope[] = [];
  if (c.monitoring) scopes.push("monitoring");
  if (c.locationSharing === "group") scopes.push("location.group");
  if (c.locationSharing === "host" || c.shareLocationWithResponders) scopes.push("location.responders");
  return scopes;
}

export function recipientRef(
  session: SessionDoc,
  r: Recipient,
  level?: EscalationLevel,
): { id: string; role: "host" | "participant" | "backup_contact" | "emergency_service_sim" } {
  if (r.kind === "emergency_simulated") return { id: "emergency_service_sim", role: "emergency_service_sim" };
  if (r.kind === "backup_contact") return { id: r.contactId, role: "backup_contact" };
  if (level === "group") {
    const participant = session.participants.find((p) => p.userId === r.userId);
    if (participant) return { id: participant.participantId, role: "participant" };
  }
  const host = session.participants.find((p) => p.role === "host" && p.userId === r.userId);
  if (host) return { id: host.participantId, role: "host" };
  // A backup contact who has a YTC account.
  for (const p of session.participants) {
    const c = p.backupContacts.find((x) => x.userId === r.userId);
    if (c) return { id: c.id, role: "backup_contact" };
  }
  return { id: r.userId, role: "backup_contact" };
}

const t = (d: Date) => d.toISOString();

export function recorder(deps: Deps) {
  const tl = deps.timeline;
  const self = (p: ParticipantDoc) => ({ kind: p.role === "host" ? ("host" as const) : ("participant" as const), id: p.participantId });

  return {
    sessionCreated(session: SessionDoc, host: ParticipantDoc) {
      return tl.append(session._id, {
        type: "session.created",
        participant_id: host.participantId,
        actor: self(host),
        provenance: prov("session_manager", { origin: "live_device" }),
        occurred_at: t(session.createdAt),
        data: {
          expires_at: t(session.expiresAt),
          checkin_response_window_ms: session.rules.checkInWindowSec * 1000,
          escalation_steps: [
            { step: 1, target_role: "host", ack_window_ms: session.rules.hostAckWindowSec * 1000, max_repeats: MAX_REPEATS },
            { step: 2, target_role: "participant", ack_window_ms: session.rules.backupAckWindowSec * 1000, max_repeats: MAX_REPEATS },
            { step: 3, target_role: "emergency_service_sim", ack_window_ms: 0, max_repeats: 0 },
          ],
          thresholds_validated: false,
        },
      });
    },

    async joined(session: SessionDoc, p: ParticipantDoc, via: "host_created" | "invite_link" | "qr_code") {
      await tl.append(session._id, {
        type: "session.participant_joined",
        participant_id: p.participantId,
        actor: self(p),
        provenance: prov("session_manager", { origin: "live_device" }),
        data: { role: p.role === "host" ? "host" : "member", joined_via: via },
      });
      await this.consentChanged(session, p, null, p.consent);
    },

    /** Consent is the person's own act (selfActorOnly in the catalog). This pair of events is the audit trail. */
    async consentChanged(session: SessionDoc, p: ParticipantDoc, before: ParticipantConsent | null, after: ParticipantConsent) {
      const was = new Set(before ? consentScopes(before) : []);
      const now = new Set(consentScopes(after));
      const revoked = [...was].filter((s) => !now.has(s));
      const granted = [...now].filter((s) => !was.has(s));
      if (revoked.length > 0) {
        await tl.append(session._id, {
          type: "consent.revoked",
          participant_id: p.participantId,
          actor: self(p),
          provenance: prov("ui", { origin: "live_device" }),
          data: { scopes: revoked },
        });
      }
      if (granted.length > 0) {
        await tl.append(session._id, {
          type: "consent.granted",
          participant_id: p.participantId,
          actor: self(p),
          provenance: prov("ui", { origin: "live_device" }),
          data: { scopes: granted, consent_text_version: p.consentTextVersion },
        });
      }
    },

    left(session: SessionDoc, p: ParticipantDoc, reason: "voluntary" | "session_ended" | "session_expired") {
      return tl.append(session._id, {
        type: "session.participant_left",
        participant_id: p.participantId,
        actor: reason === "voluntary" ? self(p) : { kind: "system", id: null },
        provenance: prov("session_manager"),
        data: { reason },
      });
    },

    ended(session: SessionDoc, host: ParticipantDoc) {
      return tl.append(session._id, {
        type: "session.ended",
        actor: self(host),
        provenance: prov("session_manager", { origin: "live_device" }),
        data: { reason: "host_ended" },
      });
    },

    expired(session: SessionDoc) {
      return tl.append(session._id, {
        type: "session.expired",
        actor: { kind: "scheduler", id: null },
        provenance: prov("session_manager"),
        occurred_at: t(session.expiresAt),
        data: { expires_at: t(session.expiresAt) },
      });
    },

    checkInPrompted(session: SessionDoc, c: CheckInDoc) {
      return tl.append(session._id, {
        type: "checkin.prompted",
        participant_id: c.participantId,
        actor: { kind: "system", id: null },
        provenance: prov("session_manager"),
        occurred_at: t(c.promptedAt),
        data: {
          checkin_id: c._id,
          trigger: c.reason === "movement_changed" ? "motion_anomaly" : "manual",
          delivery: "in_app",
          response_deadline_at: t(c.dueAt),
        },
      });
    },

    checkInResponded(session: SessionDoc, p: ParticipantDoc, c: CheckInDoc, response: "confirmed_ok" | "requested_help", at: Date) {
      return tl.append(session._id, {
        type: "checkin.responded",
        participant_id: p.participantId,
        actor: self(p),
        provenance: prov("ui", { origin: "live_device" }),
        data: { checkin_id: c._id, response, method: "tap", latency_ms: Math.max(0, at.getTime() - c.promptedAt.getTime()) },
      });
    },

    checkInMissed(session: SessionDoc, c: CheckInDoc) {
      return tl.append(session._id, {
        type: "checkin.missed",
        participant_id: c.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler"),
        occurred_at: t(c.dueAt),
        data: { checkin_id: c._id, response_deadline_at: t(c.dueAt) },
      });
    },

    incidentOpened(session: SessionDoc, incident: IncidentDoc, triggerEventId: string) {
      return tl.append(session._id, {
        type: "incident.opened",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "system", id: null },
        provenance: prov("incident_manager"),
        caused_by: [triggerEventId],
        data: { trigger: incident.trigger, trigger_event_id: triggerEventId },
      });
    },

    notificationSent(session: SessionDoc, incident: IncidentDoc, job: NotificationJobDoc) {
      const r = recipientRef(session, job.recipient, job.level);
      return tl.append(session._id, {
        type: "notification.sent",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("transport_sim", { simulated: true }),
        caused_by: incident.openedEventId ? [incident.openedEventId] : [],
        data: {
          notification_id: job._id,
          recipient_id: r.id,
          recipient_role: r.role,
          channel: "in_app_sim",
          escalation_step: job.stepIndex + 1,
          attempt: job.repeat + 1,
          is_repeat: job.repeat > 0,
          delivered_fact_event_ids: job.payload.factEventIds,
        },
      });
    },

    notificationDelivered(session: SessionDoc, job: NotificationJobDoc) {
      return tl.append(session._id, {
        type: "notification.delivered",
        incident_id: job.incidentId,
        actor: { kind: "transport_sim", id: null },
        provenance: prov("transport_sim", { simulated: true }),
        data: { notification_id: job._id, recipient_id: recipientRef(session, job.recipient, job.level).id },
      });
    },

    notificationFailed(session: SessionDoc, job: NotificationJobDoc, willRetry: boolean) {
      return tl.append(session._id, {
        type: "notification.delivery_failed",
        incident_id: job.incidentId,
        actor: { kind: "transport_sim", id: null },
        provenance: prov("transport_sim", { simulated: true }),
        data: { notification_id: job._id, recipient_id: recipientRef(session, job.recipient, job.level).id, reason: "transport_error", will_retry: willRetry },
      });
    },

    notificationViewed(session: SessionDoc, job: NotificationJobDoc) {
      return tl.append(session._id, {
        type: "notification.viewed",
        incident_id: job.incidentId,
        actor: { kind: recipientRef(session, job.recipient, job.level).role === "host" ? "host" : recipientRef(session, job.recipient, job.level).role === "participant" ? "participant" : "backup_contact", id: recipientRef(session, job.recipient, job.level).id },
        provenance: prov("ui", { origin: "live_device" }),
        data: { notification_id: job._id, recipient_id: recipientRef(session, job.recipient, job.level).id },
      });
    },

    stepScheduled(session: SessionDoc, incident: IncidentDoc, index: number, dueAt: Date, basisEventId: string) {
      const step = incident.steps[index]!;
      return tl.append(session._id, {
        type: "escalation.step_scheduled",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler"),
        data: {
          escalation_id: step.escalationId,
          step: index + 1,
          target_role: step.level === "host" ? "host" : step.level === "group" ? "participant" : step.level === "backup" ? "backup_contact" : "emergency_service_sim",
          due_at: t(dueAt),
          deadline_basis_event_id: basisEventId,
        },
      });
    },

    stepFired(session: SessionDoc, incident: IncidentDoc, index: number, dueAt: Date, now: Date) {
      const step = incident.steps[index]!;
      return tl.append(session._id, {
        type: "escalation.step_fired",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler"),
        occurred_at: t(dueAt),
        data: {
          escalation_id: step.escalationId,
          step: index + 1,
          target_role: step.level === "host" ? "host" : step.level === "group" ? "participant" : step.level === "backup" ? "backup_contact" : "emergency_service_sim",
          scheduled_due_at: t(dueAt),
          fired_late_ms: Math.max(0, now.getTime() - dueAt.getTime()),
        },
      });
    },

    stepCancelled(session: SessionDoc, incident: IncidentDoc, index: number, reason: "acknowledged" | "resolved" | "session_ended") {
      return tl.append(session._id, {
        type: "escalation.step_cancelled",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler"),
        data: { escalation_id: incident.steps[index]!.escalationId, step: index + 1, reason },
      });
    },

    emergencyDispatch(session: SessionDoc, incident: IncidentDoc, index: number, factEventIds: string[]) {
      return tl.append(session._id, {
        type: "emergency.simulated_dispatch_requested",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler", { simulated: true }),
        data: { mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID, escalation_id: incident.steps[index]!.escalationId, delivered_fact_event_ids: factEventIds },
      });
    },

    acknowledged(session: SessionDoc, incident: IncidentDoc, job: NotificationJobDoc) {
      const r = recipientRef(session, job.recipient, job.level);
      const actorKind = r.role === "host" ? "host" : r.role === "participant" ? "participant" : "backup_contact";
      return tl.append(session._id, {
        type: "incident.acknowledged",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: actorKind, id: r.id },
        provenance: prov("ui", { origin: "live_device" }),
        data: { acknowledged_by_role: actorKind, acknowledged_by_id: r.id, notification_id: job._id },
      });
    },

    resolved(session: SessionDoc, incident: IncidentDoc, by: { role: "host" | "participant" | "backup_contact"; id: string }, outcome: "false_alarm" | "assistance_reached" | "other") {
      return tl.append(session._id, {
        type: "incident.resolved",
        incident_id: incident._id,
        participant_id: incident.participantId,
        actor: { kind: by.role, id: by.id },
        provenance: prov("ui", { origin: "live_device" }),
        data: {
          resolution: outcome === "assistance_reached" ? "assistance_reached_participant" : outcome,
          resolved_by_role: by.role,
          resolved_by_id: by.id,
        },
      });
    },

    deviceOffline(session: SessionDoc, p: ParticipantDoc, lastSeen: Date) {
      return tl.append(session._id, {
        type: "connectivity.device_offline",
        participant_id: p.participantId,
        actor: { kind: "system", id: null },
        provenance: prov("session_manager"),
        data: { last_seen_at: t(lastSeen), detected_by: "heartbeat_timeout", heartbeat_interval_ms: session.rules.heartbeatTimeoutSec * 1000 },
      });
    },

    deviceOnline(session: SessionDoc, p: ParticipantDoc, offlineMs: number) {
      return tl.append(session._id, {
        type: "connectivity.device_online",
        participant_id: p.participantId,
        actor: { kind: "system", id: null },
        provenance: prov("session_manager"),
        data: { offline_duration_ms: Math.max(0, Math.round(offlineMs)) },
      });
    },

    /** Only called while an incident about the person is active (location rule). */
    location(session: SessionDoc, p: ParticipantDoc, fix: { latitude: number; longitude: number; accuracyM: number; fixAt: Date }, origin: "live_device" | "synthetic_scenario" = "live_device") {
      return tl.append(session._id, {
        type: "location.reported",
        participant_id: p.participantId,
        actor: { kind: "participant", id: p.participantId },
        provenance: prov("sensor_adapter", { origin }),
        occurred_at: t(fix.fixAt),
        data: {
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracy_m: fix.accuracyM,
          fix_at: t(fix.fixAt),
          source: origin === "synthetic_scenario" ? "synthetic" : "gnss",
          speed_m_s: null,
          heading_deg: null,
        },
      });
    },

    /** A client's own catalog event (sensor, profile, location), re-recorded on the server's chain. */
    copyClientEvent(session: SessionDoc, e: TimelineEvent) {
      return tl.append(session._id, {
        type: e.type,
        data: e.data as never,
        actor: e.actor,
        provenance: e.provenance,
        incident_id: e.incident_id,
        participant_id: e.participant_id,
        occurred_at: e.occurred_at,
      });
    },
  };
}

export type Recorder = ReturnType<typeof recorder>;
