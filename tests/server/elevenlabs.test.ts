import { describe, expect, it } from "vitest";
import { ELEVENLABS_API, ELEVENLABS_DEFAULT_VOICE, ElevenLabsSpeech, SpeechError, forSpeech } from "../../src/server/elevenlabs.js";

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const s = { url: String(url), init: init ?? {} };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  return { fn, seen };
}

describe("ElevenLabs speech", () => {
  it("streams text-to-speech from the fixed API with the low-latency model", async () => {
    const { fn, seen } = fakeFetch(() => new Response("mp3-bytes", { headers: { "content-type": "audio/mpeg" } }));
    const speech = new ElevenLabsSpeech({ apiKey: "test-key", fetch: fn });
    const { stream, contentType } = await speech.synthesize("Impact of at least 153.6 m/s² at 11:50:57 PM UTC near -79.3957.");
    expect(await new Response(stream).text()).toBe("mp3-bytes");
    expect(contentType).toBe("audio/mpeg");
    expect(seen[0]!.url).toBe(`${ELEVENLABS_API}/v1/text-to-speech/${ELEVENLABS_DEFAULT_VOICE}/stream?output_format=mp3_44100_128`);
    expect((seen[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const body = JSON.parse(seen[0]!.init.body as string);
    expect(body.model_id).toBe("eleven_flash_v2_5");
    expect(body.text).toBe("Impact of at least 153.6 metres per second squared at 11:50:57 PM U T C near minus 79.3957.");
  });

  it("transcribes one recording with Scribe", async () => {
    const { fn, seen } = fakeFetch(() => Response.json({ text: "  Where are they?  " }));
    const speech = new ElevenLabsSpeech({ apiKey: "k", fetch: fn });
    expect(await speech.transcribe(new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus")).toBe("Where are they?");
    expect(seen[0]!.url).toBe(`${ELEVENLABS_API}/v1/speech-to-text`);
    const form = seen[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    const file = form.get("file") as File;
    expect([file.name, file.size]).toEqual(["operator.webm", 3]);
  });

  it("turns provider failures into SpeechErrors without leaking the body", async () => {
    const denied = new ElevenLabsSpeech({
      apiKey: "k",
      fetch: fakeFetch(() => Response.json({ detail: { message: "missing permission" } }, { status: 401 })).fn,
    });
    await expect(denied.transcribe(new Uint8Array(1), "audio/webm")).rejects.toMatchObject({ name: "SpeechError", status: 502, message: "ElevenLabs 401: missing permission" });

    const offline = new ElevenLabsSpeech({ apiKey: "k", fetch: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).fn });
    await expect(offline.synthesize("hi")).rejects.toBeInstanceOf(SpeechError);

    const slow = new ElevenLabsSpeech({ apiKey: "k", timeoutMs: 20, fetch: ((_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch });
    await expect(slow.synthesize("hi")).rejects.toMatchObject({ status: 504 });
  });

  it("refuses a malformed voice ID", () => {
    expect(() => new ElevenLabsSpeech({ apiKey: "k", voiceId: "../v1/convai" })).toThrow(/invalid ElevenLabs voice ID/);
  });

  it("changes pronunciation only, never the words or values", () => {
    expect(forSpeech("coordinates 43.6629, -79.3957")).toBe("coordinates 43.6629, minus 79.3957");
    expect(forSpeech("Last-known location, not live")).toBe("Last-known location, not live");
    expect(forSpeech("about 15.7 g")).toBe("about 15.7 g");
  });
});
