/**
 * HTTP routes for simulated calls, mounted on the YTC backend server.
 *
 *   GET  /api/health
 *   POST /api/calls                              start a call; returns the opening breakdown
 *   GET  /api/calls/:id                          transcript, fact sheet, voice log
 *   POST /api/calls/:id/turns      {text}        operator turn, typed
 *   POST /api/calls/:id/speech     audio body    operator turn, spoken (transcribed server-side)
 *   POST /api/calls/:id/silence    {ms}
 *   POST /api/calls/:id/interrupt  {turn_index, heard_ms}
 *   POST /api/calls/:id/end
 *   GET  /api/calls/:id/turns/:n/audio           speech for agent turn n
 *
 * There is no route that speaks arbitrary text: audio is only ever made from
 * an agent turn already logged in the timeline.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { CallError, type CallService } from "./calls.js";
import { SpeechError } from "./elevenlabs.js";
import type { HealthResponse } from "./protocol.js";

const JSON_LIMIT = 16 * 1024;
const AUDIO_LIMIT = 10 * 1024 * 1024;
const CALL = "(call_[A-Za-z0-9-]+)";

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void>;

export interface ApiOptions {
  /** Shown by /api/health: which models back reasoning, speech in and speech out. */
  reasoning: string | null;
}

export function createApiHandler(calls: CallService, opts: ApiOptions) {
  const routes: [string, RegExp, Handler][] = [
    [
      "GET",
      /^\/api\/health$/,
      async (_req, res) => {
        const body: HealthResponse = { ok: true, reasoning: opts.reasoning, speech_to_text: calls.speech?.sttId ?? null, text_to_speech: calls.speech?.ttsId ?? null };
        send(res, 200, body);
      },
    ],
    ["POST", /^\/api\/calls$/, async (_req, res) => send(res, 201, calls.start())],
    ["GET", new RegExp(`^/api/calls/${CALL}$`), async (_req, res, [id]) => send(res, 200, calls.state(id!))],
    [
      "POST",
      new RegExp(`^/api/calls/${CALL}/turns$`),
      async (req, res, [id]) => {
        const body = await readJson(req);
        send(res, 200, await calls.operatorText(id!, stringField(body, "text")));
      },
    ],
    [
      "POST",
      new RegExp(`^/api/calls/${CALL}/speech$`),
      async (req, res, [id]) => {
        const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
        if (!type.startsWith("audio/") && !type.startsWith("video/")) throw new CallError("Send the recording as an audio/* body.", 415);
        const audio = await readBody(req, AUDIO_LIMIT);
        send(res, 200, await calls.operatorSpeech(id!, audio, req.headers["content-type"]!));
      },
    ],
    [
      "POST",
      new RegExp(`^/api/calls/${CALL}/silence$`),
      async (req, res, [id]) => send(res, 200, calls.silence(id!, numberField(await readJson(req), "ms"))),
    ],
    [
      "POST",
      new RegExp(`^/api/calls/${CALL}/interrupt$`),
      async (req, res, [id]) => {
        const body = await readJson(req);
        send(res, 200, calls.interrupt(id!, numberField(body, "turn_index"), numberField(body, "heard_ms")));
      },
    ],
    ["POST", new RegExp(`^/api/calls/${CALL}/end$`), async (_req, res, [id]) => send(res, 200, calls.end(id!))],
    [
      "GET",
      new RegExp(`^/api/calls/${CALL}/turns/(\\d{1,4})/audio$`),
      async (_req, res, [id, n]) => {
        const speech = calls.speech;
        if (!speech) throw new CallError("Text-to-speech is not configured.", 503);
        const text = calls.agentTurnText(id!, Number(n));
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        const audio = await speech.synthesize(text, abort.signal);
        res.writeHead(200, { "Content-Type": audio.contentType, "Cache-Control": "no-store" });
        Readable.fromWeb(audio.stream as import("node:stream/web").ReadableStream<Uint8Array>)
          .on("error", () => res.destroy())
          .pipe(res);
      },
    ],
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0]!;
    try {
      const matches = routes.filter(([, re]) => re.test(path));
      if (matches.length === 0) throw new CallError("Not found.", 404);
      const route = matches.find(([method]) => method === req.method);
      if (!route) throw new CallError("Method not allowed.", 405);
      await route[2](req, res, route[1].exec(path)!.slice(1));
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof CallError || err instanceof SpeechError) {
        send(res, err.status, { error: err.message });
      } else {
        console.error("[api]", req.method, path, err);
        send(res, 500, { error: "The server hit an unexpected error. The call's timeline is unchanged." });
      }
    }
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new CallError("Request body too large.", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new CallError("Request body too large.", 413);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = Buffer.from(await readBody(req, JSON_LIMIT)).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // not JSON; rejected below
  }
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
