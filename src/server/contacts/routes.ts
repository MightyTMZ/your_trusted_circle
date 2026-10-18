/**
 * Backup contacts with their own YTC account. Until a contact accepts an
 * invite, alerts to them go through the simulated transport. After, alerts
 * reach their YTC inbox and they can acknowledge and resolve, seeing only
 * what their alerts delivered (alerts/routes.ts).
 *
 * POST /api/sessions/:id/me/backup-contacts/:contactId/invite   I create a link for one of my contacts
 * GET  /api/contact-invites/:token                              preview: who is asking, for which session
 * POST /api/contact-invites/accept   { token }                  the contact, signed in, accepts
 *
 * Only the participant who listed the contact can invite them. The invite
 * token is a 256-bit secret shown once; only its hash is stored. It expires
 * with the session and works once.
 */
import { Hono } from "hono";
import { v, validate } from "../../timeline/schema/validate.js";
import { activeParticipant, isLive } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newToken, sha256 } from "../ids.js";

const acceptSchema = v.object({ token: v.string({ minLength: 20, maxLength: 100 }) });

export function contactRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  r.post("/sessions/:id/me/backup-contacts/:contactId/invite", auth, async (c) => {
    const session = await deps.store.getSession(c.req.param("id"));
    const me = session ? activeParticipant(session, c.var.user._id) : undefined;
    if (!session || !me) return fail(c, 404, "no_session", "You are not in this session.");
    if (!isLive(session, deps.now())) return fail(c, 409, "session_over", "This session has ended.");
    const contact = me.backupContacts.find((x) => x.id === c.req.param("contactId"));
    if (!contact) return fail(c, 404, "no_contact", "That backup contact isn't on your list.");
    if (contact.userId) return fail(c, 409, "already_linked", `${contact.name} has already joined with an account.`);
    const token = newToken();
    await deps.store.insertContactInvite({
      _id: sha256(token),
      sessionId: session._id,
      participantId: me.participantId,
      contactId: contact.id,
      createdAt: deps.now(),
      expiresAt: session.expiresAt,
      acceptedByUserId: null,
    });
    return c.json({ inviteUrl: `${deps.config.appOrigin}/#contact-invite=${token}`, expiresAt: session.expiresAt }, 201);
  });

  async function liveInvite(token: string) {
    const invite = await deps.store.getContactInvite(sha256(token));
    if (!invite || invite.acceptedByUserId !== null || invite.expiresAt.getTime() <= deps.now().getTime()) return null;
    const session = await deps.store.getSession(invite.sessionId);
    const owner = session?.participants.find((p) => p.participantId === invite.participantId && p.leftAt === null);
    const contact = owner?.backupContacts.find((x) => x.id === invite.contactId);
    return session && owner && contact ? { invite, session, owner, contact } : null;
  }

  r.get("/contact-invites/:token", auth, async (c) => {
    const found = await liveInvite(c.req.param("token"));
    if (!found) return fail(c, 404, "no_invite", "This invite has expired or was already used.");
    return c.json({ invite: { from: found.owner.displayName, sessionName: found.session.name, asName: found.contact.name, expiresAt: found.invite.expiresAt } });
  });

  r.post("/contact-invites/accept", auth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (validate(acceptSchema, body).length > 0) return fail(c, 400, "invalid_request", "Send the invite token.");
    const { token } = body as { token: string };
    const found = await liveInvite(token);
    if (!found) return fail(c, 404, "no_invite", "This invite has expired or was already used.");
    if (found.owner.userId === c.var.user._id) return fail(c, 409, "own_invite", "You can't be your own backup contact.");
    if (!(await deps.store.acceptContactInvite(sha256(token), c.var.user._id))) {
      return fail(c, 404, "no_invite", "This invite has expired or was already used.");
    }
    if (!(await deps.store.linkBackupContact(found.session._id, found.owner.participantId, found.contact.id, c.var.user._id))) {
      return fail(c, 409, "already_linked", "This contact is already linked to an account.");
    }
    return c.json({ linked: { for: found.owner.displayName, sessionName: found.session.name } });
  });

  return r;
}
