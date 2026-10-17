/**
 * The Incident Card (CLAUDE.md): a timestamped list of what was observed and
 * done, built only from the session's hash-chained timeline. Every line is the
 * catalog's deterministic summary of an event, never free text.
 *
 * Two views:
 * - full (the host, or the person it is about): the incident's own events,
 *   the check-in that triggered it, and the person's location fixes during it
 *   when their consent allows the viewer to see them;
 * - delivered (anyone else who was alerted): only the facts their alerts
 *   delivered, plus acknowledgment and resolution (CLAUDE.md: recipients may
 *   use only information actually delivered to them).
 */
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import type { IncidentDoc, ParticipantDoc, SessionDoc } from "../types.js";

export interface CardEntry {
  eventId: string;
  at: string;
  type: string;
  summary: string;
  simulated: boolean;
}

export function buildIncidentCard(
  events: readonly TimelineEvent[],
  session: SessionDoc,
  incident: IncidentDoc,
  viewer: { kind: "full"; viewerIsHost: boolean } | { kind: "delivered"; factEventIds: ReadonlySet<string>; notificationIds: ReadonlySet<string> },
) {
  const subject: ParticipantDoc | undefined = session.participants.find((p) => p.participantId === incident.participantId);
  const checkInId = incident.checkInId;
  const openedMs = incident.openedAt.getTime();
  const resolvedMs = incident.resolved?.at.getTime() ?? Number.POSITIVE_INFINITY;

  const include = (e: TimelineEvent): boolean => {
    if (viewer.kind === "delivered") {
      if (viewer.factEventIds.has(e.event_id)) return true;
      if (e.incident_id !== incident._id) return false;
      if (e.type === "incident.acknowledged" || e.type === "incident.resolved") return true;
      const nid = (e.data as { notification_id?: string }).notification_id;
      return nid !== undefined && viewer.notificationIds.has(nid);
    }
    if (e.incident_id === incident._id) return true;
    if (e.event_id === incident.triggerEventId) return true;
    if (checkInId && e.type.startsWith("checkin.") && (e.data as { checkin_id?: string }).checkin_id === checkInId) return true;
    if (e.type === "location.reported" && e.participant_id === incident.participantId) {
      const at = Date.parse(e.occurred_at);
      if (at < openedMs || at > resolvedMs || !subject) return false;
      const c = subject.consent;
      return !viewer.viewerIsHost || c.locationSharing !== "off" || c.shareLocationWithResponders;
    }
    return false;
  };

  const entries: CardEntry[] = events.filter(include).map((e) => ({
    eventId: e.event_id,
    at: e.occurred_at,
    type: e.type,
    summary: e.summary,
    simulated: e.provenance.simulated,
  }));

  return {
    incidentId: incident._id,
    sessionName: session.name,
    about: subject?.displayName ?? "Unknown",
    status: incident.status,
    openedAt: incident.openedAt,
    view: viewer.kind,
    entries,
    notes: [
      "Built from the session's hash-chained timeline. Each line is generated from the recorded event, not written by hand.",
      "Movement changes are observations, not medical conclusions.",
      "Acknowledgment confirms the alert was received. It does not confirm the person's wellbeing.",
      "Emergency services and the voice call are simulated. No real emergency service was contacted.",
    ],
  };
}
