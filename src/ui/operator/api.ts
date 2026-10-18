// Browser client for the simulated-call routes on the YTC backend (/api/calls, proxied by Vite).
// No keys here: speech and reasoning providers are called only by the server.
import type {
  CallUpdateResponse,
  CallView,
  CapabilitiesResponse,
  ErrorResponse,
  IncomingCall,
  SpeechRequest,
  StartCallResponse,
  TurnResponse,
} from '../../server/voice/protocol';

const OFFLINE = 'The YTC backend is not running. Start it with npm run server (or npm run dev:full).';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
  // The backend accepts JSON only on writes, so even a bare POST sends {}.
  const body = method === 'GET' ? undefined : (payload ?? {});
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the dev proxy's own error page
  }
  if (!res.ok) {
    const msg = (parsed as ErrorResponse | null)?.error?.message;
    throw new ApiError(msg ?? (res.status >= 500 ? OFFLINE : `Request failed (${res.status}).`), res.status);
  }
  return parsed as T;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const callApi = {
  capabilities: () => request<CapabilitiesResponse>('GET', '/api/calls/capabilities'),
  start: () => request<StartCallResponse>('POST', '/api/calls'),
  incoming: () => request<{ calls: IncomingCall[] }>('GET', '/api/calls/incoming'),
  answer: (id: string) => request<StartCallResponse>('POST', `/api/calls/${id}/answer`),
  state: (id: string) => request<{ call: CallView }>('GET', `/api/calls/${id}`),
  say: (id: string, text: string) => request<TurnResponse>('POST', `/api/calls/${id}/turns`, { text }),
  speak: async (id: string, audio: Blob) => {
    const body: SpeechRequest = { audio_base64: await toBase64(audio), mime_type: audio.type || 'audio/webm' };
    return request<TurnResponse>('POST', `/api/calls/${id}/speech`, body);
  },
  silence: (id: string, ms: number) => request<CallUpdateResponse>('POST', `/api/calls/${id}/silence`, { ms }),
  interrupt: (id: string, turnIndex: number, heardMs: number) =>
    request<{ call: CallView }>('POST', `/api/calls/${id}/interrupt`, { turn_index: turnIndex, heard_ms: heardMs }),
  end: (id: string) => request<{ call: CallView }>('POST', `/api/calls/${id}/end`),
};
