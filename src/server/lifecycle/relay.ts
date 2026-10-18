/**
 * Live group location, relayed but never stored (decision: option A).
 *
 * The group map needs live positions, but the backend stores no location
 * outside an active incident. So the latest fix per participant is kept only
 * in this process's memory, shown to the people its owner allowed, and
 * forgotten after 2 × locationStaleAfterSec. Nothing here reaches MongoDB,
 * the traces collection, logs, or the data export.
 *
 * The one exception is unchanged from before: while an incident about the
 * person is active, their fixes are also stored (lifecycle/location.ts), so
 * responders and the incident record have a last-known position.
 *
 * Limitation: memory is per process. Running several API instances would
 * need a shared in-memory cache with expiry (e.g. Redis TTL keys) instead.
 *
 * POST /api/sessions/:id/location    send my own latest fix
 * GET  /api/sessions/:id/locations   fixes I am allowed to see, labelled live or stale
 */
import { Hono } from "hono";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { activeParticipant, isHost, isLive } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newId } from "../ids.js";
import { recorder } from "../timeline/recorder.js";
import type { ParticipantDoc, SessionDoc } from "../types.js";
import { mayStoreLocation } from "./location.js";

export interface LiveFix {
  participantId: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** Demo "teleport": a made-up position around the demo venue, not the phone's GPS. */
  simulated: boolean;
  fixAt: Date;
  receivedAt: Date;
  /** Forgotten after this. */
  expiresAt: Date;
}

/** Device clocks drift; a fix may be this far in the future. */
const MAX_FUTURE_SKEW_MS = 30_000;

export class LocationRelay {
  private readonly bySession = new Map<string, Map<string, LiveFix>>();

  put(sessionId: string, fix: LiveFix): void {
    let fixes = this.bySession.get(sessionId);
    if (!fixes) this.bySession.set(sessionId, (fixes = new Map()));
    fixes.set(fix.participantId, fix);
  }

  /** Unexpired fixes for a session. Expired ones are dropped on the way. */
  list(sessionId: string, now: Date): LiveFix[] {
    const fixes = this.bySession.get(sessionId);
    if (!fixes) return [];
    for (const [id, f] of fixes) if (f.expiresAt.getTime() <= now.getTime()) fixes.delete(id);
    if (fixes.size === 0) this.bySession.delete(sessionId);
    return [...fixes.values()];
  }

  clearParticipant(sessionId: string, participantId: string): void {
    const fixes = this.bySession.get(sessionId);
    fixes?.delete(participantId);
    if (fixes?.size === 0) this.bySession.delete(sessionId);
  }

  /** Drops demo "teleport" positions, e.g. when the host clears the demo venue. */
  clearSimulated(sessionId: string): void {
    const fixes = this.bySession.get(sessionId);
    if (!fixes) return;
    for (const [id, f] of fixes) if (f.simulated) fixes.delete(id);
    if (fixes.size === 0) this.bySession.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Housekeeping, run by the scheduler. */
  sweep(now: Date): void {
    for (const sessionId of [...this.bySession.keys()]) this.list(sessionId, now);
  }

  /** For tests and diagnostics: how many fixes are held. */
  get size(): number {
    let n = 0;
    for (const fixes of this.bySession.values()) n += fixes.size;
    return n;
  }
}

const fixSchema = v.object({
  latitude: v.number({ min: -90, max: 90 }),
  longitude: v.number({ min: -180, max: 180 }),
  accuracyM: v.number({ min: 0, max: 100_000 }),
  fixAt: v.timestamp(),
  simulated: v.optional(v.boolean()),
});

/** Does this person currently allow anyone to see their live position? */
function relayAllowed(session: SessionDoc, p: ParticipantDoc, hasActiveIncident: boolean): boolean {
  if (!session.rules.allowLocationSharing) return false;
  if (p.consent.locationSharing !== "off") return true;
  // Sharing is off, but they chose to share with responders during an incident.
  return hasActiveIncident && p.consent.shareLocationWithResponders;
}

/**
 * Who may see a participant's live fix (CLAUDE.md: location only according
 * to participant permissions):
 * - themselves, always;
 * - everyone in the session, if they share with "group";
 * - the host, if they share with "host", or with responders during an incident.
 */
export function canSeeLive(session: SessionDoc, viewer: ParticipantDoc, subject: ParticipantDoc, subjectHasIncident: boolean): boolean {
  if (viewer.participantId === subject.participantId) return true;
  if (subject.consent.locationSharing === "group") return true;
  if (!isHost(session, viewer.userId)) return false;
  return subject.consent.locationSharing === "host" || (subjectHasIncident && subject.consent.shareLocationWithResponders);
}

export function relayRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  r.post("/sessions/:id/location", auth, async (c) => {
    const session = await deps.store.getSession(c.req.param("id"));
    const me = session ? activeParticipant(session, c.var.user._id) : undefined;
    if (!session || !me) return fail(c, 404, "no_session", "You are not in this session.");
    const now = deps.now();
    if (!isLive(session, now)) return fail(c, 409, "session_over", "This session has ended.");
    if (session.suspendedAt) {
      deps.relay.clearParticipant(session._id, me.participantId);
      return c.json({ relayed: false, stored: false, reason: "session_suspended" }, 202);
    }

    const body = await c.req.json().catch(() => undefined);
    const issues = validate(fixSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the location fix.", issues);
    const input = body as Infer<typeof fixSchema>;
    const fixAt = new Date(input.fixAt);
    const keepMs = 2 * session.rules.locationStaleAfterSec * 1000;
    if (fixAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return fail(c, 400, "future_fix", "The fix time is in the future.");
    if (now.getTime() - fixAt.getTime() >= keepMs) return c.json({ relayed: false, stored: false, reason: "too_old" }, 202);

    const incident = await deps.store.findActiveIncident(session._id, me.participantId);
    if (!relayAllowed(session, me, incident !== null)) {
      deps.relay.clearParticipant(session._id, me.participantId);
      return c.json({ relayed: false, stored: false, reason: "sharing_off" }, 202);
    }

    deps.relay.put(session._id, {
      participantId: me.participantId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyM: input.accuracyM,
      simulated: input.simulated === true,
      fixAt,
      receivedAt: now,
      expiresAt: new Date(fixAt.getTime() + keepMs),
    });

    // Only during an active incident does a position reach the database.
    let stored = false;
    if (incident && mayStoreLocation(me, true)) {
      const trace = {
        _id: newId("trc"),
        userId: me.userId,
        sessionId: session._id,
        participantId: me.participantId,
        subjectParticipantId: me.participantId,
        kind: "sensor" as const,
        type: "location.fix",
        occurredAt: fixAt,
        receivedAt: now,
        data: { latitude: input.latitude, longitude: input.longitude, accuracyM: input.accuracyM, simulated: input.simulated === true, incidentId: incident._id },
        locationRedacted: false,
        eventId: null,
        clientItemId: null,
        dataOrigin: input.simulated === true ? "synthetic_scenario" as const : "live_device" as const,
        dataClass: "derived" as const,
        units: "degrees, metres",
        timelineEventId: null,
      };
      await deps.store.insertTraces([trace]);
      // On the timeline too, so the briefing and Incident Card have the last known position.
      const event = await recorder(deps).location(session, me, { latitude: input.latitude, longitude: input.longitude, accuracyM: input.accuracyM, fixAt }, trace.dataOrigin);
      if (event) await deps.store.setTraceTimelineEvent(trace._id, event.event_id);
      stored = true;
    }
    return c.json({ relayed: true, stored }, 202);
  });

  r.get("/sessions/:id/locations", auth, async (c) => {
    const session = await deps.store.getSession(c.req.param("id"));
    const viewer = session ? activeParticipant(session, c.var.user._id) : undefined;
    if (!session || !viewer) return fail(c, 404, "no_session", "You are not in this session.");
    const now = deps.now();
    const staleMs = session.rules.locationStaleAfterSec * 1000;

    const locations = [];
    for (const fix of deps.relay.list(session._id, now)) {
      const subject = session.participants.find((p) => p.participantId === fix.participantId && p.leftAt === null);
      if (!subject) continue;
      const incident = await deps.store.findActiveIncident(session._id, subject.participantId);
      // Consent can change after a fix was relayed; check it again at read time.
      if (!relayAllowed(session, subject, incident !== null)) continue;
      if (!canSeeLive(session, viewer, subject, incident !== null)) continue;
      const ageMs = Math.max(0, now.getTime() - fix.fixAt.getTime());
      locations.push({
        participantId: subject.participantId,
        displayName: subject.displayName,
        isYou: subject.participantId === viewer.participantId,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyM: fix.accuracyM,
        simulated: fix.simulated,
        fixAt: fix.fixAt,
        ageSec: Math.round(ageMs / 1000),
        // CLAUDE.md: distinguish last-known from current location.
        status: ageMs <= staleMs ? "live" : "stale",
      });
    }
    c.header("Cache-Control", "no-store");
    return c.json({ locations, staleAfterSec: session.rules.locationStaleAfterSec });
  });

  return r;
}
