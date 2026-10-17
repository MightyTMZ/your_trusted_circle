import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CallService, type CallServiceOptions } from "../../src/server/calls.js";
import type { SpeechProvider } from "../../src/server/elevenlabs.js";
import { createApiHandler } from "../../src/server/http.js";
import type { CallView, StartCallResponse, TurnResponse } from "../../src/server/protocol.js";
import { ScriptedModel, idInPrompt, supported } from "../agent/helpers.js";

class FakeSpeech implements SpeechProvider {
  readonly ttsId = "fake-tts";
  readonly sttId = "fake-stt";
  heard = "Where are they right now?";
  spoken: string[] = [];
  received: { bytes: number; mimeType: string }[] = [];

  async synthesize(text: string) {
    this.spoken.push(text);
    return { stream: new Blob([`AUDIO:${text}`]).stream(), contentType: "audio/mpeg" };
  }

  async transcribe(audio: Uint8Array, mimeType: string) {
    this.received.push({ bytes: audio.byteLength, mimeType });
    return this.heard;
  }
}

const location = (req: Parameters<ConstructorParameters<typeof ScriptedModel>[1]>[0]) => ({
  intent: "answer",
  sentences: [{ text: "Their last-known location is Synthetic Venue A, rear patio; their current location is unknown.", fact_ids: [idInPrompt(req, "Last-known location")] }],
});

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

async function serve(opts: CallServiceOptions = {}) {
  let wall = 0;
  const calls = new CallService({ wallClock: () => wall, ...opts });
  const handler = createApiHandler(calls, { reasoning: "fake" });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async <T>(method: string, path: string, body?: unknown, type = "application/json") => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": type },
      body: body === undefined ? undefined : body instanceof Uint8Array || typeof body === "string" ? (body as BodyInit) : JSON.stringify(body),
    });
    return { status: res.status, body: (res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text()) as T };
  };
  return { api, calls, advance: (ms: number) => (wall += ms) };
}

describe("simulated call API", () => {
  it("opens with a full breakdown read from the record, with speech for it", async () => {
    const { api } = await serve({ speech: new FakeSpeech() });
    const { status, body } = await api<StartCallResponse>("POST", "/api/calls");
    expect(status).toBe(201);
    const { reply, call } = body;
    expect(reply.path).toBe("scripted");
    expect(reply.text).toMatch(/^Hello, this is an automated assistant from the YTC group safety app, not a person, and this is a simulated call\./);
    for (const part of ["Sam (synthetic)", "private check-in went unanswered", "sudden impact", "Last-known location, not live", "inhaler", "Nobody has acknowledged"]) {
      expect(reply.text).toContain(part);
    }
    expect(reply.audio_url).toBe(`/api/calls/${call.call_id}/turns/0/audio`);
    expect(call.facts.length).toBeGreaterThan(20);
    expect(call.log.map((l) => l.type)).toEqual(["voice.call_started", "voice.utterance"]);
  });

  it("answers a typed operator turn through the agent pipeline", async () => {
    const model = new ScriptedModel("fake-model", location);
    const { api } = await serve({ models: { model, judge: new ScriptedModel("fake-judge", () => supported(1)) } });
    const { body: start } = await api<StartCallResponse>("POST", "/api/calls");
    const { status, body } = await api<TurnResponse>("POST", `/api/calls/${start.call.call_id}/turns`, { text: "Where are they?" });
    expect(status).toBe(200);
    expect(body.reply!.path).toBe("model");
    expect(body.reply!.facts.map((f) => f.topic)).toEqual(["location"]);
    expect(body.reply!.audio_url).toBeNull();
    expect(body.call.transcript.map((t) => t.speaker)).toEqual(["voice_agent", "mock_operator", "voice_agent"]);
  });

  it("transcribes a spoken turn server-side, then treats it exactly like text", async () => {
    const speech = new FakeSpeech();
    const { api } = await serve({ speech });
    const { body: start } = await api<StartCallResponse>("POST", "/api/calls");
    const { status, body } = await api<TurnResponse>("POST", `/api/calls/${start.call.call_id}/speech`, new Uint8Array(4000), "audio/webm;codecs=opus");
    expect(status).toBe(200);
    expect(speech.received).toEqual([{ bytes: 4000, mimeType: "audio/webm;codecs=opus" }]);
    expect(body.operator_text).toBe("Where are they right now?");
    expect(body.call.transcript[1]).toMatchObject({ speaker: "mock_operator", text: "Where are they right now?" });
    expect(body.reply!.text).toContain("Last-known location, not live");
  });

  it("rejects unusable speech turns", async () => {
    const speech = new FakeSpeech();
    const { api } = await serve({ speech });
    const id = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    speech.heard = "";
    expect((await api("POST", `/api/calls/${id}/speech`, new Uint8Array(10), "audio/webm")).status).toBe(422);
    expect((await api("POST", `/api/calls/${id}/speech`, "hello", "text/plain")).status).toBe(415);
    const noVoice = await serve();
    const other = (await noVoice.api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    expect((await noVoice.api("POST", `/api/calls/${other}/speech`, new Uint8Array(10), "audio/webm")).status).toBe(503);
    expect((await noVoice.api("GET", `/api/calls/${other}/turns/0/audio`)).status).toBe(503);
  });

  it("speaks only text already logged as an agent turn", async () => {
    const speech = new FakeSpeech();
    const { api } = await serve({ speech });
    const { body: start } = await api<StartCallResponse>("POST", "/api/calls");
    const audio = await api<string>("GET", `/api/calls/${start.call.call_id}/turns/0/audio`);
    expect(audio.status).toBe(200);
    expect(audio.body).toBe(`AUDIO:${start.reply.text}`);
    expect(speech.spoken).toEqual([start.reply.text]);
    await api("POST", `/api/calls/${start.call.call_id}/turns`, { text: "Where are they?" });
    expect((await api("GET", `/api/calls/${start.call.call_id}/turns/1/audio`)).status).toBe(404);
    expect((await api("GET", `/api/calls/${start.call.call_id}/turns/99/audio`)).status).toBe(404);
  });

  it("logs a barge-in and tells the model the operator may not have heard the rest", async () => {
    const model = new ScriptedModel("fake", location);
    const { api } = await serve({ models: { model, judge: new ScriptedModel("judge", () => supported(1)) } });
    const id = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    const cut = await api<{ call: CallView }>("POST", `/api/calls/${id}/interrupt`, { turn_index: 0, heard_ms: 4200 });
    expect(cut.body.call.transcript[0]!.interrupted_after_ms).toBe(4200);
    expect(cut.body.call.log.at(-1)!.type).toBe("voice.agent_interrupted");
    expect((await api("POST", `/api/calls/${id}/interrupt`, { turn_index: 3, heard_ms: 10 })).status).toBe(400);
    await api("POST", `/api/calls/${id}/turns`, { text: "Sorry, where?" });
    expect(model.requests[0]!.prompt).toContain("[cut off: the operator interrupted");
  });

  it("prompts once on silence, then ends the call; an ended call takes no turns", async () => {
    const { api } = await serve();
    const id = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    const first = await api<{ call: CallView; reply: { text: string } }>("POST", `/api/calls/${id}/silence`, { ms: 25000 });
    expect(first.body.reply.text).toContain("Are you still there?");
    const second = await api<{ call: CallView }>("POST", `/api/calls/${id}/silence`, { ms: 25000 });
    expect(second.body.call).toMatchObject({ status: "ended", ended_reason: "timeout" });
    expect((await api("POST", `/api/calls/${id}/turns`, { text: "Hello?" })).status).toBe(409);
    expect((await api<{ call: CallView }>("GET", `/api/calls/${id}`)).body.call.status).toBe("ended");
  });

  it("hangs up on request", async () => {
    const { api } = await serve();
    const id = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    const ended = await api<{ call: CallView }>("POST", `/api/calls/${id}/end`);
    expect(ended.body.call).toMatchObject({ status: "ended", ended_reason: "operator_hangup" });
  });

  it("keeps time moving with the real clock, and new events continue the fixture's IDs", async () => {
    const { api, advance } = await serve();
    const { body: start } = await api<StartCallResponse>("POST", "/api/calls");
    const opened = Date.parse(start.call.transcript[0]!.at);
    advance(5 * 60_000);
    const { body } = await api<TurnResponse>("POST", `/api/calls/${start.call.call_id}/turns`, { text: "Where are they?" });
    expect(Date.parse(body.call.transcript.at(-1)!.at) - opened).toBe(5 * 60_000);
    const before = start.call.facts.find((f) => f.topic === "location")!.text;
    const after = body.call.facts.find((f) => f.topic === "location")!.text;
    expect(after).not.toBe(before);
    const ids = body.call.log.map((l) => Number(l.event_id.slice(4)));
    expect(ids[0]).toBe(start.call.timeline_events - 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns clear errors for unknown calls and bad requests", async () => {
    const { api } = await serve();
    expect((await api("GET", "/api/calls/call_9999")).status).toBe(404);
    expect((await api("DELETE", "/api/calls")).status).toBe(405);
    expect((await api("GET", "/api/nothing")).status).toBe(404);
    const id = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    expect((await api("POST", `/api/calls/${id}/turns`, "not json", "application/json")).status).toBe(400);
    expect((await api("POST", `/api/calls/${id}/turns`, { text: 5 })).status).toBe(400);
    expect((await api("POST", `/api/calls/${id}/turns`, { text: "x".repeat(20_000) })).status).toBe(413);
  });

  it("keeps a bounded number of calls, dropping ended ones first", async () => {
    const { api } = await serve({ maxCalls: 2 });
    const a = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    const b = (await api<StartCallResponse>("POST", "/api/calls")).body.call.call_id;
    await api("POST", `/api/calls/${b}/end`);
    await api("POST", "/api/calls");
    expect((await api("GET", `/api/calls/${b}`)).status).toBe(404);
    expect((await api("GET", `/api/calls/${a}`)).status).toBe(200);
  });
});
