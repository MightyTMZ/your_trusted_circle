/**
 * Session lifecycle. Every route requires a signed-in user.
 *
 * POST  /api/sessions                    host creates a session (host joins as its first participant)
 * GET   /api/sessions                    sessions I am in
 * GET   /api/sessions/join/:code         preview before joining (name, host, rules)
 * POST  /api/sessions/join               join by code (typed, or read from the QR link #join=CODE)
 * GET   /api/sessions/:id                session as I am allowed to see it
 * GET   /api/sessions/:id/invite         host only: code, join link and QR (SVG)
 * PATCH /api/sessions/:id/rules          host only: session-wide rules
 * PATCH /api/sessions/:id/me/consent     a participant changes their own sharing
 * POST  /api/sessions/:id/leave          a participant leaves
 * POST  /api/sessions/:id/end            host ends the session for everyone
 *
 * Consent is per person (CLAUDE.md): nobody, including the host, can change
 * another participant's sharing or monitoring.
 */
import { Hono } from "hono";
import QRCode from "qrcode";
import { v, validate, type Infer } from "../../timeline/schema/validate.js";
import { activeParticipant, anyParticipant, isHost, isLive } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newId, newJoinCode, normalizeJoinCode } from "../ids.js";
import type { ParticipantConsent, ParticipantDoc, SessionDoc, SessionRules, UserDoc } from "../types.js";

const consentSchema = v.object({
  monitoring: v.boolean(),
  locationSharing: v.enum(["group", "host", "off"] as const),
  shareLocationWithResponders: v.boolean(),
});

/** Synthetic names only in demos (CLAUDE.md). Two at most, as in the client. */
const backupContactsSchema = v.array(
  v.object({ name: v.string({ minLength: 1, maxLength: 40 }), relation: v.string({ minLength: 1, maxLength: 40 }) }),
  { maxLength: 2 },
);

const rulesPatchSchema = v.object({
  checkInWindowSec: v.optional(v.number({ min: 15, max: 600, integer: true })),
  hostAckWindowSec: v.optional(v.number({ min: 30, max: 1800, integer: true })),
  backupAckWindowSec: v.optional(v.number({ min: 30, max: 3600, integer: true })),
  locationStaleAfterSec: v.optional(v.number({ min: 15, max: 600, integer: true })),
  heartbeatTimeoutSec: v.optional(v.number({ min: 30, max: 1800, integer: true })),
  maxParticipants: v.optional(v.number({ min: 2, max: 50, integer: true })),
  allowLocationSharing: v.optional(v.boolean()),
});

const createSchema = v.object({
  name: v.string({ minLength: 1, maxLength: 60 }),
  durationMin: v.number({ integer: true }),
  consent: consentSchema,
  backupContacts: v.optional(backupContactsSchema),
  rules: v.optional(rulesPatchSchema),
});

const joinSchema = v.object({
  code: v.string({ minLength: 6, maxLength: 12 }),
  consent: consentSchema,
  backupContacts: v.optional(backupContactsSchema),
});

type RulesPatch = Infer<typeof rulesPatchSchema>;
type ContactsInput = Infer<typeof backupContactsSchema> | undefined;

/** The session rules cap what any one person can share. */
function capConsent(consent: ParticipantConsent, rules: SessionRules): ParticipantConsent {
  return rules.allowLocationSharing ? consent : { ...consent, locationSharing: "off", shareLocationWithResponders: false };
}

function mergeRules(base: SessionRules, patch: RulesPatch | undefined): SessionRules {
  const next = { ...base };
  for (const [k, value] of Object.entries(patch ?? {})) if (value !== undefined) (next as Record<string, unknown>)[k] = value;
  return next;
}

function newParticipant(user: UserDoc, role: ParticipantDoc["role"], consent: ParticipantConsent, contacts: ContactsInput, now: Date): ParticipantDoc {
  return {
    participantId: newId("par"),
    userId: user._id,
    displayName: user.displayName,
    role,
    joinedAt: now,
    leftAt: null,
    consent,
    backupContacts: (contacts ?? []).map((c) => ({ id: newId("con"), name: c.name.trim(), relation: c.relation.trim() })),
    lastHeartbeatAt: now,
    deviceOnline: true,
  };
}

/**
 * What a member may see. Other people appear by display name, role and
 * whether their device is reachable; their user ids and backup contacts stay
 * private. The host also sees each person's sharing choices, since the host
 * is the first responder (CLAUDE.md).
 */
function sessionView(s: SessionDoc, viewer: UserDoc, now: Date) {
  const me = anyParticipant(s, viewer._id);
  const host = isHost(s, viewer._id);
  return {
    id: s._id,
    name: s.name,
    status: isLive(s, now) ? "active" : s.status === "ended" ? "ended" : "expired",
    endedReason: s.endedReason,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    rules: s.rules,
    isHost: host,
    me: me
      ? {
          participantId: me.participantId,
          role: me.role,
          joinedAt: me.joinedAt,
          leftAt: me.leftAt,
          consent: me.consent,
          backupContacts: me.backupContacts.map((c) => ({ name: c.name, relation: c.relation })),
        }
      : null,
    participants: s.participants
      .filter((p) => p.leftAt === null)
      .map((p) => ({
        participantId: p.participantId,
        displayName: p.displayName,
        role: p.role,
        isYou: p.userId === viewer._id,
        deviceOnline: p.deviceOnline,
        ...(host ? { consent: p.consent } : {}),
      })),
    ...(host ? { code: s.code } : {}),
  };
}

export function sessionRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth(deps));
  const joinUrl = (code: string) => `${deps.config.appOrigin}/#join=${code}`;

  async function uniqueCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = newJoinCode();
      if (!(await deps.store.isCodeTaken(code))) return code;
    }
    throw new Error("Could not allocate a join code");
  }

  async function loadMember(id: string, userId: string) {
    const s = await deps.store.getSession(id);
    return s && anyParticipant(s, userId) ? s : null;
  }

  async function cancelPendingCheckIns(sessionId: string, participantId: string | null, reason: "participant_left" | "session_ended") {
    for (const c of await deps.store.listPendingCheckIns(sessionId)) {
      if (participantId === null || c.participantId === participantId) {
        await deps.store.transitionCheckIn(c._id, "pending", { status: "cancelled", cancelledReason: reason });
      }
    }
  }

  r.post("/", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(createSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the session details.", issues);
    const input = body as Infer<typeof createSchema>;
    if (!deps.config.allowedDurationsMin.includes(input.durationMin)) {
      return fail(c, 400, "invalid_duration", `Pick one of: ${deps.config.allowedDurationsMin.join(", ")} minutes.`);
    }
    const user = c.var.user;
    const now = deps.now();
    const rules = mergeRules(deps.config.defaultRules, input.rules);
    const session: SessionDoc = {
      _id: newId("ses"),
      code: await uniqueCode(),
      name: input.name.trim(),
      hostUserId: user._id,
      status: "active",
      endedReason: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.durationMin * 60_000),
      endedAt: null,
      rules,
      participants: [newParticipant(user, "host", capConsent(input.consent, rules), input.backupContacts, now)],
    };
    await deps.store.insertSession(session);
    return c.json({ session: sessionView(session, user, now), joinUrl: joinUrl(session.code) }, 201);
  });

  r.get("/", async (c) => {
    const now = deps.now();
    const sessions = await deps.store.listSessionsForUser(c.var.user._id);
    return c.json({ sessions: sessions.map((s) => sessionView(s, c.var.user, now)) });
  });

  r.get("/join/:code", async (c) => {
    const code = normalizeJoinCode(c.req.param("code"));
    const s = code ? await deps.store.getSessionByCode(code) : null;
    if (!s || !isLive(s, deps.now())) return fail(c, 404, "no_session", "No active session for that code.");
    const host = s.participants.find((p) => p.role === "host");
    return c.json({ session: { name: s.name, hostName: host?.displayName ?? null, expiresAt: s.expiresAt, rules: s.rules } });
  });

  r.post("/join", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(joinSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the join details.", issues);
    const input = body as Infer<typeof joinSchema>;
    const code = normalizeJoinCode(input.code);
    const now = deps.now();
    const user = c.var.user;
    const s = code ? await deps.store.getSessionByCode(code) : null;
    if (!s || !isLive(s, now)) return fail(c, 404, "no_session", "No active session for that code.");

    const existing = anyParticipant(s, user._id);
    if (existing && existing.leftAt === null) return c.json({ session: sessionView(s, user, now) });
    if (existing) return fail(c, 409, "already_left", "You left this session. Ask the host for a new one.");

    const participant = newParticipant(user, "participant", capConsent(input.consent, s.rules), input.backupContacts, now);
    if (!(await deps.store.addParticipant(s._id, participant, s.rules.maxParticipants))) {
      return fail(c, 409, "session_full", "This session is full.");
    }
    return c.json({ session: sessionView((await deps.store.getSession(s._id))!, user, now) }, 201);
  });

  r.get("/:id", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    if (!s) return fail(c, 404, "no_session", "Session not found.");
    return c.json({ session: sessionView(s, c.var.user, deps.now()) });
  });

  r.get("/:id/invite", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    if (!s) return fail(c, 404, "no_session", "Session not found.");
    if (!isHost(s, c.var.user._id)) return fail(c, 403, "host_only", "Only the host can show the invite.");
    if (!isLive(s, deps.now())) return fail(c, 409, "session_over", "This session has ended.");
    const url = joinUrl(s.code);
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return c.json({ code: s.code, joinUrl: url, qrSvg });
  });

  r.patch("/:id/rules", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    if (!s) return fail(c, 404, "no_session", "Session not found.");
    if (!isHost(s, c.var.user._id)) return fail(c, 403, "host_only", "Only the host can change session rules.");
    if (!isLive(s, deps.now())) return fail(c, 409, "session_over", "This session has ended.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(rulesPatchSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the rules.", issues);
    const rules = mergeRules(s.rules, body as RulesPatch);
    const active = s.participants.filter((p) => p.leftAt === null).length;
    if (rules.maxParticipants < active) return fail(c, 409, "too_many_participants", `${active} people are already in this session.`);
    await deps.store.setSessionRules(s._id, rules);
    // Turning location sharing off for the session switches it off for everyone at once.
    if (!rules.allowLocationSharing) {
      for (const p of s.participants) await deps.store.setParticipantConsent(s._id, p.participantId, capConsent(p.consent, rules));
    }
    return c.json({ session: sessionView((await deps.store.getSession(s._id))!, c.var.user, deps.now()) });
  });

  r.patch("/:id/me/consent", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    const me = s && activeParticipant(s, c.var.user._id);
    if (!s || !me) return fail(c, 404, "no_session", "You are not in this session.");
    if (!isLive(s, deps.now())) return fail(c, 409, "session_over", "This session has ended.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(consentSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check your sharing choices.", issues);
    await deps.store.setParticipantConsent(s._id, me.participantId, capConsent(body as ParticipantConsent, s.rules));
    return c.json({ session: sessionView((await deps.store.getSession(s._id))!, c.var.user, deps.now()) });
  });

  r.post("/:id/leave", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    const me = s && activeParticipant(s, c.var.user._id);
    if (!s || !me) return fail(c, 404, "no_session", "You are not in this session.");
    if (me.role === "host") return fail(c, 409, "host_must_end", "As host, end the session instead of leaving it.");
    await deps.store.updateParticipant(s._id, me.participantId, { leftAt: deps.now() });
    // Leaving stops new check-ins. An alert already open about you stays open for your host.
    await cancelPendingCheckIns(s._id, me.participantId, "participant_left");
    return c.body(null, 204);
  });

  r.post("/:id/end", async (c) => {
    const s = await loadMember(c.req.param("id"), c.var.user._id);
    if (!s) return fail(c, 404, "no_session", "Session not found.");
    if (!isHost(s, c.var.user._id)) return fail(c, 403, "host_only", "Only the host can end the session.");
    const open = (await deps.store.listIncidentsForSession(s._id)).some((i) => i.activeKey !== null);
    if (open) return fail(c, 409, "open_incidents", "Resolve open alerts before ending the session.");
    await deps.store.endSession(s._id, "host_ended", deps.now());
    await cancelPendingCheckIns(s._id, null, "session_ended");
    return c.body(null, 204);
  });

  return r;
}
