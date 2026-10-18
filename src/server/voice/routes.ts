/**
 * Simulated voice-agent escalation, mounted at /api/calls on the backend
 * (app.ts). The person at the operator console plays the mock operator; no
 * route can reach a real one.
 *
 *   GET  /api/calls/capabilities                 which models answer, speak and listen
 *   POST /api/calls                              start a practice call; returns the opening breakdown
 *   GET  /api/calls/incoming                     calls placed by escalation, still ringing
 *   POST /api/calls/:id/answer                   pick up a ringing call; returns the opening breakdown
 *   GET  /api/calls/:id                          transcript, fact sheet, voice log
 *   POST /api/calls/:id/turns      {text}        operator turn, typed
 *   POST /api/calls/:id/speech     {audio_base64, mime_type}   operator turn, spoken
 *   POST /api/calls/:id/silence    {ms}
 *   POST /api/calls/:id/interrupt  {turn_index, heard_ms}
 *   POST /api/calls/:id/end
 *   GET  /api/calls/:id/turns/:n/audio           speech for agent turn n (streamed MP3)
 *
 * No route speaks arbitrary text: audio is only ever made from an agent
 * turn already logged in the timeline. The app's Origin check and
 * JSON-only rule apply here too, so recordings travel as base64 JSON.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fail, type AppEnv, type Deps } from "../context.js";
import { activeParticipant } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { CallError, type CallService } from "./calls.js";
import { SpeechError } from "./elevenlabs.js";

const ID = ":id{call_[A-Za-z0-9-]+}";
const tooLarge = (c: Context) => fail(c, 413, "too_large", "Request body too large.");
const small = bodyLimit({ maxSize: 16 * 1024, onError: tooLarge });
/** About 5 MB of audio once base64 is decoded: minutes of compressed speech. */
const recording = bodyLimit({ maxSize: 7 * 1024 * 1024, onError: tooLarge });

export function voiceRoutes(calls: CallService, deps: Deps) {
  const r = new Hono<AppEnv>();
  const auth = requireAuth(deps);

  const withCallAccess = async (c: Context<AppEnv>, callId: string, next: () => Promise<Response>) => {
    const access = calls.access(callId);
    if (!access || access.kind === "practice") return next();
    let denied: Response | null = null;
    const authResponse = await auth(c, async () => {
      const session = access.sessionId ? await deps.store.getSession(access.sessionId) : null;
      if (!session || !activeParticipant(session, c.var.user._id)) {
        denied = fail(c, 403, "call_forbidden", "You are not a member of this session.");
        return;
      }
    });
    return authResponse ?? denied ?? next();
  };

  r.get("/capabilities", (c) => c.json(calls.capabilities()));
  r.post("/", (c) => c.json(calls.start(), 201));
  r.get("/incoming", auth, async (c) => {
    const visible = [];
    for (const incoming of calls.incoming()) {
      const access = calls.access(incoming.call_id);
      const session = access?.sessionId ? await deps.store.getSession(access.sessionId) : null;
      if (session && activeParticipant(session, c.var.user._id)) visible.push(incoming);
    }
    return c.json({ calls: visible });
  });
  r.post(`/${ID}/answer`, (c) => withCallAccess(c, c.req.param("id"), async () => c.json(calls.answer(c.req.param("id")))));
  r.get(`/${ID}`, (c) => withCallAccess(c, c.req.param("id"), async () => c.json(calls.state(c.req.param("id")))));

  r.post(`/${ID}/turns`, small, async (c) => {
    return withCallAccess(c, c.req.param("id"), async () => {
      const body = await readJson(c);
      return c.json(await calls.operatorText(c.req.param("id"), stringField(body, "text")));
    });
  });

  r.post(`/${ID}/speech`, recording, async (c) => {
    return withCallAccess(c, c.req.param("id"), async () => {
      const body = await readJson(c);
      const mime = stringField(body, "mime_type");
      if (!/^(audio|video)\/[\w.+-]+(;[\w=.+-]+)*$/.test(mime.replace(/\s/g, ""))) throw new CallError("mime_type must be an audio type.", 400);
      const audio = Buffer.from(stringField(body, "audio_base64"), "base64");
      return c.json(await calls.operatorSpeech(c.req.param("id"), new Uint8Array(audio), mime));
    });
  });

  r.post(`/${ID}/silence`, small, async (c) =>
    withCallAccess(c, c.req.param("id"), async () => c.json(calls.silence(c.req.param("id"), numberField(await readJson(c), "ms")))),
  );

  r.post(`/${ID}/interrupt`, small, async (c) => {
    return withCallAccess(c, c.req.param("id"), async () => {
      const body = await readJson(c);
      return c.json(calls.interrupt(c.req.param("id"), numberField(body, "turn_index"), numberField(body, "heard_ms")));
    });
  });

  r.post(`/${ID}/end`, (c) => withCallAccess(c, c.req.param("id"), async () => c.json(calls.end(c.req.param("id")))));

  r.get(`/${ID}/turns/:n{[0-9]{1,4}}/audio`, async (c) => {
    return withCallAccess(c, c.req.param("id"), async () => {
      const speech = calls.speech;
      if (!speech) throw new CallError("Text-to-speech is not configured.", 503);
      const text = calls.agentTurnText(c.req.param("id"), Number(c.req.param("n")));
      const audio = await speech.synthesize(text, c.req.raw.signal);
      return new Response(audio.stream, { headers: { "Content-Type": audio.contentType, "Cache-Control": "no-store" } });
    });
  });

  r.onError((err, c) => {
    if (err instanceof CallError) return fail(c, err.status as ContentfulStatusCode, codeFor(err.status), err.message);
    if (err instanceof SpeechError) return fail(c, err.status as ContentfulStatusCode, "speech_failed", err.message);
    // Same policy as app.ts: log the error type only.
    console.error(`[calls] ${c.req.method} ${c.req.path} failed: ${err.name}`);
    return fail(c, 500, "server_error", "The call hit an unexpected error. Its timeline is unchanged.");
  });
  return r;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  throw new CallError("Body must be a JSON object.", 400);
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new CallError(`"${key}" must be a string.`, 400);
  return value;
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CallError(`"${key}" must be a number.`, 400);
  return value;
}

function codeFor(status: number): string {
  return (
    { 400: "bad_request", 404: "not_found", 409: "call_ended", 413: "too_large", 422: "no_speech", 503: "not_configured" }[status] ?? "call_error"
  );
}
