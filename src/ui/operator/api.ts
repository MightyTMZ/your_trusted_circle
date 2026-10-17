// Browser client for the simulated-call routes on the YTC backend (/api, proxied by Vite).
// No keys here: speech and reasoning providers are called only by the server.
import type {
  CallUpdateResponse,
  CallView,
  ErrorResponse,
  HealthResponse,
  StartCallResponse,
  TurnResponse,
} from '../../server/protocol';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: BodyInit, contentType?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, body, headers: contentType ? { 'Content-Type': contentType } : undefined });
  } catch {
    throw new ApiError('The YTC backend is not reachable. Start it with npm run server.', 0);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the proxy's own error page
  }
  if (!res.ok) {
    const msg = (parsed as ErrorResponse | null)?.error;
    throw new ApiError(msg ?? (res.status >= 500 ? 'The YTC backend is not reachable. Start it with npm run server.' : `Request failed (${res.status}).`), res.status);
  }
  return parsed as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const callApi = {
  health: () => request<HealthResponse>('GET', '/api/health'),
  start: () => request<StartCallResponse>('POST', '/api/calls'),
  state: (id: string) => request<{ call: CallView }>('GET', `/api/calls/${id}`),
  say: (id: string, text: string) => request<TurnResponse>('POST', `/api/calls/${id}/turns`, json({ text }), 'application/json'),
  speak: (id: string, audio: Blob) => request<TurnResponse>('POST', `/api/calls/${id}/speech`, audio, audio.type || 'audio/webm'),
  silence: (id: string, ms: number) => request<CallUpdateResponse>('POST', `/api/calls/${id}/silence`, json({ ms }), 'application/json'),
  interrupt: (id: string, turnIndex: number, heardMs: number) =>
    request<{ call: CallView }>('POST', `/api/calls/${id}/interrupt`, json({ turn_index: turnIndex, heard_ms: heardMs }), 'application/json'),
  end: (id: string) => request<{ call: CallView }>('POST', `/api/calls/${id}/end`),
};
