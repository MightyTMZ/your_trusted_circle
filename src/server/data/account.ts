/**
 * The signed-in user's own account. Every route acts only on that user.
 *
 * GET    /api/me          profile and linked sign-in providers
 * PATCH  /api/me          change display name and/or profile picture (avatar: image data URL, or null to remove)
 * GET    /api/me/export   download a copy of everything stored about me (JSON)
 * DELETE /api/me          delete my account and all my data; body { "confirm": "DELETE" }
 *
 * Deleting removes: the user, every sign-in, every trace I sent and every
 * trace about me, my check-ins, incidents about me, alerts about me or sent
 * to me, my place in other people's sessions, and the sessions I host (with
 * their check-ins, incidents, alerts and timeline), raw recordings, and invites.
 * In sessions I only joined, my events are removed from the hash-chained
 * timeline and the remaining chain is re-verified and re-sealed
 * (timeline/record.ts). Other people's own traces in a session I hosted
 * remain theirs to export or delete.
 */
import { Hono } from "hono";
import { v, validate } from "../../timeline/schema/validate.js";
import { checkInView } from "../safety/routes.js";
import { endAuthSession, requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { avatarProblem } from "./avatar.js";

const profileSchema = v.object({
  displayName: v.optional(v.string({ minLength: 1, maxLength: 40 })),
  avatar: v.optional(v.nullable(v.string())),
});
const deleteSchema = v.object({ confirm: v.literal("DELETE") });

export function accountRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth(deps));

  const profile = (u: AppEnv["Variables"]["user"]) => ({
    id: u._id,
    displayName: u.displayName,
    avatar: u.avatar ?? null,
    email: u.email,
    emailVerified: u.emailVerified,
    providers: u.identities.map((i) => i.provider),
    createdAt: u.createdAt,
  });

  r.get("/", (c) => c.json({ user: profile(c.var.user) }));

  r.patch("/", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (validate(profileSchema, body).length > 0) {
      return fail(c, 400, "invalid_request", "Send displayName (1 to 40 characters), avatar (an image or null), or both.");
    }
    const { displayName, avatar } = body as { displayName?: string; avatar?: string | null };
    if (displayName === undefined && avatar === undefined) return fail(c, 400, "invalid_request", "Nothing to change.");
    const patch: { displayName?: string; avatar?: string | null } = {};
    if (displayName !== undefined) {
      patch.displayName = displayName.trim();
      if (patch.displayName.length === 0) return fail(c, 400, "invalid_request", "Display name cannot be blank.");
    }
    if (avatar !== undefined) {
      const problem = avatar === null ? null : avatarProblem(avatar);
      if (problem) return fail(c, 400, "invalid_avatar", problem);
      patch.avatar = avatar;
    }
    await deps.store.updateUser(c.var.user._id, patch, deps.now());
    return c.json({ user: profile((await deps.store.getUser(c.var.user._id))!) });
  });

  r.get("/export", async (c) => {
    const user = c.var.user;
    const sessions = await deps.store.listSessionsForUser(user._id);
    const mine = new Set(sessions.flatMap((s) => s.participants.filter((p) => p.userId === user._id).map((p) => p.participantId)));
    const checkIns = (await Promise.all(sessions.map((s) => deps.store.listCheckInsForSession(s._id)))).flat().filter((x) => mine.has(x.participantId));
    const incidents = (await Promise.all(sessions.map((s) => deps.store.listIncidentsForSession(s._id)))).flat().filter((i) => mine.has(i.participantId));
    const alertsReceived = await deps.store.listJobsForUser(user._id);
    const traces = await deps.store.listTracesForUser(user._id, [...mine]);
    const rawRecordings = await deps.store.listRawRecordingsForUser(user._id);
    // My own record on each session timeline, including every consent choice (the audit trail).
    const myEvents = (
      await Promise.all(
        sessions.map(async (s) =>
          (await deps.timeline.events(s._id)).filter((e) => (e.participant_id !== null && mine.has(e.participant_id)) || (e.actor.id !== null && mine.has(e.actor.id))),
        ),
      )
    ).flat();
    const signIns = await deps.store.listAuthSessions(user._id);
    const exportedAt = deps.now();

    const body = {
      format: "ytc-personal-data-export",
      version: 3,
      exportedAt,
      user: {
        ...profile(user),
        identities: user.identities.map((i) => ({ provider: i.provider, subject: i.subject, linkedAt: i.linkedAt })),
        updatedAt: user.updatedAt,
      },
      signIns: signIns.map((s) => ({ createdAt: s.createdAt, expiresAt: s.expiresAt })),
      // Only my own entry in each session; other members' details are theirs.
      sessions: sessions.map((s) => {
        const me = s.participants.find((p) => p.userId === user._id)!;
        return {
          id: s._id,
          name: s.name,
          hostedByMe: s.hostUserId === user._id,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          status: s.status,
          rules: s.rules,
          me: {
            participantId: me.participantId,
            role: me.role,
            joinedAt: me.joinedAt,
            leftAt: me.leftAt,
            consent: me.consent,
            consentTextVersion: me.consentTextVersion,
            consentUpdatedAt: me.consentUpdatedAt,
            backupContacts: me.backupContacts.map((b) => ({ name: b.name, relation: b.relation, hasAccount: b.userId !== null })),
          },
        };
      }),
      checkIns: checkIns.map(checkInView),
      incidentsAboutMe: incidents.map((i) => ({
        id: i._id,
        sessionId: i.sessionId,
        trigger: i.trigger,
        openedAt: i.openedAt,
        status: i.status,
        acknowledged: i.acknowledged ? { by: i.acknowledged.name, at: i.acknowledged.at } : null,
        resolved: i.resolved ? { by: i.resolved.name, at: i.resolved.at, outcome: i.resolved.outcome } : null,
        log: i.log,
      })),
      alertsSentToMe: alertsReceived.map((j) => ({
        id: j._id,
        incidentId: j.incidentId,
        level: j.level,
        status: j.status,
        deliveredAt: j.deliveredAt,
        viewedAt: j.viewedAt,
        acknowledgedAt: j.acknowledgedAt,
        delivered: j.payload,
      })),
      timelineEvents: myEvents,
      rawRecordings: rawRecordings.map((t) => ({
        id: t._id,
        sessionId: t.sessionId,
        dataOrigin: t.dataOrigin,
        units: t.units,
        occurredAt: t.occurredAt,
        receivedAt: t.receivedAt,
        data: t.data,
      })),
      traces: traces.map((t) => ({
        id: t._id,
        kind: t.kind,
        type: t.type,
        sessionId: t.sessionId,
        sentByMe: t.userId === user._id,
        occurredAt: t.occurredAt,
        receivedAt: t.receivedAt,
        dataOrigin: t.dataOrigin,
        dataClass: t.dataClass,
        units: t.units,
        locationRedacted: t.locationRedacted,
        data: t.data,
      })),
    };
    c.header("Content-Disposition", `attachment; filename="ytc-data-${exportedAt.toISOString().slice(0, 10)}.json"`);
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  r.delete("/", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (validate(deleteSchema, body).length > 0) {
      return fail(c, 400, "confirm_required", 'Send { "confirm": "DELETE" } to delete your account and all your data.');
    }
    const user = c.var.user;
    for (const s of await deps.store.listSessionsForUser(user._id)) {
      if (s.hostUserId !== user._id) continue;
      const open = (await deps.store.listIncidentsForSession(s._id)).some((i) => i.activeKey !== null);
      if (open) return fail(c, 409, "open_incidents", "You are hosting a session with an open alert. Resolve it before deleting your account.");
    }
    // Live positions are memory-only; drop them too, including sessions I host.
    for (const s of await deps.store.listSessionsForUser(user._id)) {
      if (s.hostUserId === user._id) deps.relay.clearSession(s._id);
      for (const p of s.participants) if (p.userId === user._id) deps.relay.clearParticipant(s._id, p.participantId);
    }
    // Re-seal the timelines of sessions I only joined, without my events.
    let timelineEvents = 0;
    for (const s of await deps.store.listSessionsForUser(user._id)) {
      if (s.hostUserId === user._id) continue;
      const pids = new Set(s.participants.filter((p) => p.userId === user._id).map((p) => p.participantId));
      const aboutMe = new Set((await deps.store.listIncidentsForSession(s._id)).filter((i) => pids.has(i.participantId)).map((i) => i._id));
      timelineEvents += await deps.timeline.reseal(
        s._id,
        (e) =>
          !(e.participant_id !== null && pids.has(e.participant_id)) &&
          !(e.actor.id !== null && pids.has(e.actor.id)) &&
          !(e.incident_id !== null && aboutMe.has(e.incident_id)),
      );
    }
    const deleted = { ...(await deps.store.deleteUserCascade(user._id)), timelineEvents };
    await endAuthSession(c, deps);
    return c.json({ deleted });
  });

  return r;
}
