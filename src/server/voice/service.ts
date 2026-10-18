/**
 * Service-to-service API for the voice-agent service (box 4, Django). It is
 * triggered when an incident reaches the simulated emergency step
 * (alerts/transport.ts), then uses these endpoints with its own credential
 * (`Authorization: Bearer VOICE_AGENT_TOKEN`), never a user's sign-in.
 *
 * GET  /api/service/incidents/:id/briefing      consent-filtered operator briefing + evidence events
 * POST /api/service/incidents/:id/voice-events  record one call event (start, utterance, silence, error, end)
 *
 * Guardrails (CLAUDE.md, voice-agent behaviour):
 * - Facts come only from the timeline via buildOperatorBriefing, which applies consent.
 * - Every event is a catalog voice.* event, always marked simulated, and the
 *   only operator endpoint is the hard-coded mock (MOCK_OPERATOR_ENDPOINT_ID).
 * - An agent utterance must cite at least one timeline event, and every cited
 *   event must already exist: ungrounded speech is refused, not recorded.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { BriefingError, buildOperatorBriefing, selectEvidence } from "../../timeline/briefing.js";
import { checkTypedFields, type EventType } from "../../timeline/schema/catalog.js";
import { v, validate } from "../../timeline/schema/validate.js";
import { fail, type Deps } from "../context.js";
import { prov } from "../timeline/record.js";

const VOICE_TYPES = ["voice.call_started", "voice.utterance", "voice.silence_detected", "voice.draft_rejected", "voice.agent_error", "voice.call_ended"] as const;

const voiceEventSchema = v.object({
  type: v.enum(VOICE_TYPES),
  data: v.unknown(),
  occurredAt: v.optional(v.timestamp()),
});

function serviceAuth(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.config.voiceAgentToken;
    if (!token) return fail(c, 503, "service_disabled", "The voice-agent service is not configured.");
    const given = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return fail(c, 401, "bad_service_token", "Invalid service credential.");
    await next();
  };
}

export function voiceServiceRoutes(deps: Deps) {
  const r = new Hono();
  r.use("*", serviceAuth(deps));

  async function incidentAtEmergencyStep(id: string) {
    const incident = await deps.store.getIncident(id);
    if (!incident) return null;
    // The agent may only act on incidents that actually reached the simulated emergency step.
    const reached = incident.steps.some((s) => s.level === "emergency_simulated" && s.notifiedAt !== null);
    return reached ? incident : null;
  }

  r.get("/incidents/:id/briefing", async (c) => {
    const incident = await incidentAtEmergencyStep(c.req.param("id"));
    if (!incident) return fail(c, 404, "no_incident", "No incident at the simulated emergency step with that id.");
    const events = await deps.timeline.events(incident.sessionId);
    try {
      const briefing = buildOperatorBriefing(events, { incidentId: incident._id, now: deps.now().getTime() });
      return c.json({ briefing, evidence: selectEvidence(events, briefing) });
    } catch (err) {
      if (err instanceof BriefingError) return fail(c, 409, "no_briefing", "The incident is not on the timeline.");
      throw err;
    }
  });

  r.post("/incidents/:id/voice-events", async (c) => {
    const incident = await incidentAtEmergencyStep(c.req.param("id"));
    if (!incident) return fail(c, 404, "no_incident", "No incident at the simulated emergency step with that id.");
    const body = await c.req.json().catch(() => undefined);
    const issues = validate(voiceEventSchema, body);
    if (issues.length > 0) return fail(c, 400, "invalid_request", "Check the voice event.", issues);
    const input = body as { type: (typeof VOICE_TYPES)[number]; data: unknown; occurredAt?: string };

    const speaker = (input.data as { speaker?: string } | null)?.speaker;
    const grounding = (input.data as { grounding_event_ids?: unknown } | null)?.grounding_event_ids;
    const draft = {
      type: input.type as EventType,
      data: input.data as never,
      incident_id: incident._id,
      participant_id: incident.participantId,
      actor: { kind: speaker === "mock_operator" ? ("mock_operator" as const) : ("voice_agent" as const), id: null },
      provenance: prov("voice_agent", { simulated: true }),
      // Grounding must point at real, earlier events; the timeline checks caused_by.
      caused_by: Array.isArray(grounding) ? [...new Set(grounding.filter((x): x is string => typeof x === "string"))] : [],
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
    };
    const typed = checkTypedFields({ ...draft, incident_id: incident._id, participant_id: incident.participantId });
    if (typed.length > 0) return fail(c, 400, "invalid_event", "The voice event does not match the catalog.", typed);
    const known = new Set((await deps.timeline.events(incident.sessionId)).map((e) => e.event_id));
    const unknown = draft.caused_by.filter((id) => !known.has(id));
    if (unknown.length > 0) return fail(c, 400, "ungrounded", "Every cited event must already be on the timeline.", unknown);

    const event = await deps.timeline.append(incident.sessionId, draft);
    if (!event) return fail(c, 400, "invalid_event", "The timeline refused this event.");
    return c.json({ eventId: event.event_id, seq: event.seq }, 201);
  });

  return r;
}
