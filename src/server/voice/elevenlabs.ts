/**
 * ElevenLabs speech for the simulated call: text-to-speech for the agent's
 * turns and speech-to-text for the operator's. Server-side only; the key
 * never reaches the browser.
 *
 * Only these two REST endpoints are used. ElevenLabs' Agents platform is
 * deliberately not: it can connect to phone networks, and this project has
 * no path to a real call. The mock operator is the person at the console.
 */

/** Fixed: speech is never sent anywhere else. */
export const ELEVENLABS_API = "https://api.elevenlabs.io";
/** Lowest-latency TTS model (about 0.45 s to first audio, measured). */
export const ELEVENLABS_TTS_MODEL = "eleven_flash_v2_5";
export const ELEVENLABS_STT_MODEL = "scribe_v2";
/** A premade voice: calm, clear, available on every account. */
export const ELEVENLABS_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

const MAX_TTS_CHARS = 2000;

export interface SpeechProvider {
  readonly ttsId: string;
  readonly sttId: string;
  /** Streams MP3 audio of text. */
  synthesize(text: string, signal?: AbortSignal): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  /** Transcribes one recorded operator turn. */
  transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string>;
}

export class SpeechError extends Error {
  override name = "SpeechError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId?: string;
  ttsModel?: string;
  sttModel?: string;
  /** Time allowed until the provider starts answering. Default 10 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ElevenLabsSpeech implements SpeechProvider {
  readonly ttsId: string;
  readonly sttId: string;
  private readonly voiceId: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.voiceId = opts.voiceId || ELEVENLABS_DEFAULT_VOICE;
    if (!/^[A-Za-z0-9]{8,40}$/.test(this.voiceId)) throw new Error(`invalid ElevenLabs voice ID: ${this.voiceId}`);
    this.ttsId = `elevenlabs/${opts.ttsModel ?? ELEVENLABS_TTS_MODEL}`;
    this.sttId = `elevenlabs/${opts.sttModel ?? ELEVENLABS_STT_MODEL}`;
    this.fetch = opts.fetch ?? fetch;
  }

  async synthesize(text: string, signal?: AbortSignal) {
    const spoken = forSpeech(text).slice(0, MAX_TTS_CHARS);
    const res = await this.request(`/v1/text-to-speech/${this.voiceId}/stream?output_format=mp3_44100_128`, signal, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: spoken,
        model_id: this.opts.ttsModel ?? ELEVENLABS_TTS_MODEL,
        // Steadier than the default: a dispatcher needs every number clearly.
        voice_settings: { stability: 0.7, similarity_boost: 0.75, style: 0, speed: 1 },
      }),
    });
    if (!res.body) throw new SpeechError("text-to-speech returned no audio", 502);
    return { stream: res.body, contentType: res.headers.get("content-type") ?? "audio/mpeg" };
  }

  async transcribe(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("model_id", this.opts.sttModel ?? ELEVENLABS_STT_MODEL);
    form.append("language_code", "en");
    form.append("tag_audio_events", "false");
    form.append("file", new Blob([Buffer.from(audio)], { type: mimeType }), `operator.${extensionFor(mimeType)}`);
    const res = await this.request("/v1/speech-to-text", signal, { body: form });
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text.trim() : "";
  }

  /** POST with the key, a timeout until the response starts, and provider errors as SpeechError. */
  private async request(path: string, signal: AbortSignal | undefined, init: { headers?: Record<string, string>; body: string | FormData }): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(new SpeechError(`ElevenLabs did not answer within ${timeoutMs} ms`, 504)), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetch(`${ELEVENLABS_API}${path}`, {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, ...init.headers },
        body: init.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new SpeechError(`ElevenLabs ${res.status}: ${providerMessage(detail)}`, res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 502 : 400);
      }
      return res;
    } catch (err) {
      if (err instanceof SpeechError) throw err;
      if (controller.signal.reason instanceof SpeechError) throw controller.signal.reason;
      throw new SpeechError(`ElevenLabs request failed: ${err instanceof Error ? err.message : String(err)}`, 502);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Pronunciation only: the same words and values, written so a voice reads
 * them the way the text means them. Never changes what is said.
 */
export function forSpeech(text: string): string {
  return text
    .replace(/m\/s²/g, "metres per second squared")
    .replace(/(^|[\s(,])-(\d)/g, "$1minus $2")
    .replace(/\bUTC\b/g, "U T C");
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "bin";
}

/** The provider's message, without echoing anything long. */
function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: { message?: string } | string };
    const msg = typeof parsed.detail === "string" ? parsed.detail : parsed.detail?.message;
    if (msg) return msg.slice(0, 200);
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || "no detail";
}
