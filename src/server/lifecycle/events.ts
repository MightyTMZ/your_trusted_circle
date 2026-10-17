/**
 * POST /api/ingest — receive and store client data in the `traces` collection.
 *
 * Body: { items: [{ kind, sessionId?, occurredAt?, data }] }, up to 500 items.
 *   kind "event"  data is a complete timeline event (src/timeline). It is checked
 *                 against the event catalog, its hash-chain fields and summary.
 *   kind "log" | "action" | "sensor" | "device" | "app"
 *                 free-form JSON (≤ 256 KB per item), location keys removed.
 *
 * Who the sender is comes from the sign-in, never from the body. Items are
 * processed in order and independently: one bad item does not drop the batch.
 * See lifecycle/location.ts for when location is kept.
 *
 * Client incident events are stored as a record only. Incidents, deadlines and
 * alerts are decided by the server (safety/), never by what a client reports.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { checkEvent, specFor, type TimelineEvent } from "../../timeline/schema/catalog.js";
import { v, validate, type Infer, type Issue } from "../../timeline/schema/validate.js";
import { activeParticipant } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newId } from "../ids.js";
import { TRACE_KINDS, type ParticipantDoc, type SessionDoc, type TraceDoc } from "../types.js";
import { MAX_DEPTH, TooDeepError, mayStoreLocation, stripLocation } from "./location.js";

export const MAX_ITEMS = 500;
export const MAX_ITEM_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const batchSchema = v.object({
  items: v.array(
    v.object({
      kind: v.enum(TRACE_KINDS),
      sessionId: v.optional(v.nullable(v.id("ses"))),
      occurredAt: v.optional(v.timestamp()),
      data: v.unknown(),
    }),
    { minLength: 1, maxLength: MAX_ITEMS },
  ),
});
type Item = Infer<typeof batchSchema>["items"][number];

/** Actors that are software, not people. They may act for the sender, or for anyone if the sender is the host. */
const SYSTEM_ACTORS = new Set(["detector", "scheduler", "system", "transport_sim", "voice_agent", "mock_operator", "scenario_script", "backup_contact"]);

interface Rejection {
  index: number;
  code: string;
  message: string;
  issues?: Issue[];
}

export function ingestRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth(deps));
  r.post(
    "/",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "too_large", `Send at most ${MAX_BODY_BYTES / 1024 / 1024} MB per batch.`) }),
    async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const issues = validate(batchSchema, body);
      if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the batch format.", issues.slice(0, 20));

      const user = c.var.user;
      const now = deps.now();
      const sessions = new Map<string, SessionDoc | null>();
      const stored: TraceDoc[] = [];
      const rejected: Rejection[] = [];
      let locationDropped = 0;
      let locationFieldsRemoved = 0;

      const loadSession = async (id: string) => {
        if (!sessions.has(id)) sessions.set(id, await deps.store.getSession(id));
        return sessions.get(id) ?? null;
      };
      const incidentFlags = new Map<string, boolean>();
      const locationAllowed = async (sessionId: string, p: ParticipantDoc | undefined) => {
        if (!p) return false;
        const key = `${sessionId}:${p.participantId}`;
        if (!incidentFlags.has(key)) incidentFlags.set(key, (await deps.store.findActiveIncident(sessionId, p.participantId)) !== null);
        return mayStoreLocation(p, incidentFlags.get(key)!);
      };

      const items = (body as { items: Item[] }).items;
      for (const [index, item] of items.entries()) {
        const reject = (code: string, message: string, issues?: Issue[]) =>
          rejected.push({ index, code, message, ...(issues ? { issues: issues.slice(0, 10) } : {}) });

        const size = Buffer.byteLength(JSON.stringify(item.data ?? null));
        if (size > MAX_ITEM_BYTES) {
          reject("item_too_large", `Each item must be at most ${MAX_ITEM_BYTES / 1024} KB.`);
          continue;
        }

        const sessionId = item.sessionId ?? null;
        const session = sessionId ? await loadSession(sessionId) : null;
        const me = session ? activeParticipant(session, user._id) : undefined;
        if (sessionId && !me) {
          reject("not_in_session", "You are not in that session.");
          continue;
        }

        if (item.kind === "event") {
          if (!session || !me) {
            reject("session_required", "Timeline events need the sessionId they belong to.");
            continue;
          }
          const eventIssues = checkEvent(item.data);
          if (eventIssues.length > 0) {
            reject("invalid_event", "The event does not match the timeline schema.", eventIssues);
            continue;
          }
          const event = item.data as TimelineEvent;
          if (event.session_id !== session._id) {
            reject("session_mismatch", "The event belongs to a different session.");
            continue;
          }
          const subject = event.participant_id
            ? session.participants.find((p) => p.participantId === event.participant_id)
            : undefined;
          if (event.participant_id && !subject) {
            reject("unknown_participant", "The event is about someone who is not in this session.");
            continue;
          }
          const isHost = session.hostUserId === user._id;
          const { kind, id } = event.actor;
          if (kind === "participant" || kind === "host") {
            if (id !== me.participantId || (kind === "host" && !isHost)) {
              reject("actor_mismatch", "You can only send events you performed yourself.");
              continue;
            }
          } else if (SYSTEM_ACTORS.has(kind) && subject && subject.participantId !== me.participantId && !isHost) {
            reject("actor_mismatch", "Only the host's device may report system events about other people.");
            continue;
          }

          if (specFor(event.type).sensitivity === "location" && !(await locationAllowed(session._id, subject))) {
            locationDropped++;
            continue;
          }

          stored.push({
            _id: newId("trc"),
            userId: user._id,
            sessionId: session._id,
            participantId: me.participantId,
            subjectParticipantId: event.participant_id,
            kind: "event",
            type: event.type,
            occurredAt: new Date(event.occurred_at),
            receivedAt: now,
            data: event,
            locationRedacted: false,
          });
          continue;
        }

        let data = item.data;
        let redacted = false;
        if (!session || !(await locationAllowed(session._id, me))) {
          try {
            const result = stripLocation(item.data);
            data = result.value;
            redacted = result.removed > 0;
            locationFieldsRemoved += result.removed;
          } catch (err) {
            if (err instanceof TooDeepError) {
              reject("too_deep", `Data may be nested at most ${MAX_DEPTH} levels.`);
              continue;
            }
            throw err;
          }
        }
        stored.push({
          _id: newId("trc"),
          userId: user._id,
          sessionId,
          participantId: me?.participantId ?? null,
          subjectParticipantId: null,
          kind: item.kind,
          type: null,
          occurredAt: item.occurredAt ? new Date(item.occurredAt) : null,
          receivedAt: now,
          data,
          locationRedacted: redacted,
        });
      }

      await deps.store.insertTraces(stored);
      return c.json({
        accepted: stored.length,
        rejected,
        locationDropped,
        locationFieldsRemoved,
      });
    },
  );
  return r;
}
