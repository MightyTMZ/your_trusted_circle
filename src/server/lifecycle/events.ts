/**
 * POST /api/ingest — receive and store client data.
 *
 * Body: { items: [{ kind, sessionId?, occurredAt?, data, clientItemId?, dataOrigin?, dataClass?, units? }] },
 * up to 500 items.
 *   kind "event"  data is a complete timeline event (src/timeline), checked
 *                 against the catalog, its hash and its summary. Stored once per
 *                 (session, event_id), so an offline device can safely resend.
 *   kind "log" | "action" | "sensor" | "device" | "app"
 *                 free-form JSON (≤ 256 KB per item), location keys removed.
 *                 `dataOrigin` is required (recorded vs synthetic, CLAUDE.md).
 *                 Sensor items also need `dataClass` ("raw" | "derived") and
 *                 `units`; raw samples go to `raw_recordings`, apart from
 *                 derived features (CLAUDE.md). `clientItemId` de-duplicates resends.
 *
 * Who the sender is comes from the sign-in, never from the body. Items are
 * processed in order and independently: one bad item does not drop the batch.
 *
 * Client motion, profile and (during an incident) location events are also
 * copied onto the server's session timeline, so the voice agent's briefing and
 * the Incident Card include them. Client incident/alert events are stored as
 * a record only: incidents and deadlines are decided by the server (safety/).
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { categoryOf, checkEvent, specFor, type TimelineEvent } from "../../timeline/schema/catalog.js";
import { v, validate, type Infer, type Issue } from "../../timeline/schema/validate.js";
import { activeParticipant } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newId } from "../ids.js";
import { recorder } from "../timeline/recorder.js";
import { DATA_ORIGINS, TRACE_KINDS, type ParticipantDoc, type SessionDoc, type TraceDoc } from "../types.js";
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
      clientItemId: v.optional(v.string({ minLength: 1, maxLength: 100 })),
      dataOrigin: v.optional(v.enum(DATA_ORIGINS)),
      dataClass: v.optional(v.enum(["raw", "derived"] as const)),
      units: v.optional(v.string({ minLength: 1, maxLength: 40 })),
    }),
    { minLength: 1, maxLength: MAX_ITEMS },
  ),
});
type Item = Infer<typeof batchSchema>["items"][number];

/** Actors that are software, not people. They may act for the sender, or for anyone if the sender is the host. */
const SYSTEM_ACTORS = new Set(["detector", "scheduler", "system", "transport_sim", "voice_agent", "mock_operator", "scenario_script", "backup_contact"]);

/** Client event categories the server copies onto its own timeline. The server owns the rest. */
const COPIED_CATEGORIES = new Set(["sensor", "profile", "location"]);

interface Rejection {
  index: number;
  code: string;
  message: string;
  issues?: Issue[];
}

export function ingestRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth(deps));
  const rec = recorder(deps);
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
      const rejected: Rejection[] = [];
      let accepted = 0;
      let duplicates = 0;
      let copiedToTimeline = 0;
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
          const subject = event.participant_id ? session.participants.find((p) => p.participantId === event.participant_id) : undefined;
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

          const isLocation = specFor(event.type).sensitivity === "location";
          if (isLocation && !(await locationAllowed(session._id, subject))) {
            locationDropped++;
            continue;
          }

          const trace: TraceDoc = {
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
            eventId: event.event_id,
            clientItemId: null,
            dataOrigin: event.provenance.data_origin,
            dataClass: null,
            units: null,
            timelineEventId: null,
          };
          if (!(await deps.store.insertTraceIfAbsent(trace))) {
            duplicates++;
            continue;
          }
          accepted++;
          if (COPIED_CATEGORIES.has(categoryOf(event.type)) && event.incident_id === null) {
            const copy = await rec.copyClientEvent(session, event);
            if (copy) {
              copiedToTimeline++;
              await deps.store.setTraceTimelineEvent(trace._id, copy.event_id);
            }
          }
          continue;
        }

        if (!item.dataOrigin) {
          reject("data_origin_required", 'Say where the data came from: dataOrigin "live_device", "recorded_dataset", "synthetic_scenario" or "system_generated".');
          continue;
        }
        if (item.kind === "sensor" && (!item.dataClass || !item.units)) {
          reject("sensor_metadata_required", 'Sensor data needs dataClass ("raw" or "derived") and units (e.g. "m/s^2").');
          continue;
        }
        if (item.kind === "sensor" && session && me && !me.consent.monitoring) {
          reject("monitoring_off", "Movement monitoring is off for you in this session.");
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
        const doc: TraceDoc = {
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
          eventId: null,
          clientItemId: item.clientItemId ?? null,
          dataOrigin: item.dataOrigin,
          dataClass: item.kind === "sensor" ? item.dataClass! : null,
          units: item.units ?? null,
          timelineEventId: null,
        };
        const stored = doc.dataClass === "raw" ? await deps.store.insertRawRecordingIfAbsent(doc) : await deps.store.insertTraceIfAbsent(doc);
        if (stored) accepted++;
        else duplicates++;
      }

      return c.json({ accepted, duplicates, rejected, locationDropped, locationFieldsRemoved, copiedToTimeline });
    },
  );
  return r;
}
