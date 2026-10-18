/**
 * Calls to the YTC server (docs/backend.md). Every helper tolerates the server
 * being absent: it returns null or false, and screens show that sign-in and
 * account features are unavailable instead of pretending they worked.
 */

export const PROVIDERS = [
  'google', 
  // 'apple', 
  // 'microsoft'
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google',
  // apple: 'Apple',
  // microsoft: 'Microsoft',
};

export interface Account {
  id: string;
  displayName: string;
  /** Image data URL, or null to show initials. */
  avatar: string | null;
  email: string | null;
  providers: Provider[];
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    // Without the server, the dev server answers with the app's HTML.
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Configured sign-in providers, or null when the server can't be reached. */
export async function fetchProviders(): Promise<Provider[] | null> {
  const body = await getJson<{ providers: string[] }>('/auth/providers');
  if (!body) return null;
  return PROVIDERS.filter((p) => body.providers.includes(p));
}

/** Whether the server offers the localhost-only test sign-in (TEST_SIGN_IN=true in development). */
export async function fetchTestSignInEnabled(): Promise<boolean> {
  const body = await getJson<{ testSignIn?: boolean }>('/auth/providers');
  return body?.testSignIn === true;
}

/** Signs in as a made-up test person. Only works against a local development server. Returns an error message on failure. */
export async function testSignIn(name: string): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/test/signin', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message ?? "Couldn't sign in. Try again.";
  } catch {
    return "Couldn't reach the server. Try again.";
  }
}

/** The signed-in account, or null when signed out or the server can't be reached. */
export async function fetchAccount(): Promise<Account | null> {
  const body = await getJson<{ user: Account }>('/me');
  return body?.user ?? null;
}

/** Full-page redirect to the provider. The account is created on first sign-in. */
export function signInUrl(provider: Provider, returnTo = '/'): string {
  return `/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;
}

export const EXPORT_URL = '/api/me/export';

/** Change the display name and/or profile picture (null removes it). Returns the updated account or an error message. */
export async function updateProfile(patch: { displayName?: string; avatar?: string | null }): Promise<Account | string> {
  try {
    const res = await fetch('/api/me', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = (await res.json().catch(() => null)) as { user?: Account; error?: { message?: string } } | null;
    if (res.ok && body?.user) return body.user;
    return body?.error?.message ?? "Couldn't save. Try again.";
  } catch {
    return "Couldn't reach the server. Try again.";
  }
}

/**
 * Square-crops and shrinks a picked image to 256×256 so it fits the server's
 * 100 KB limit. WebP where the browser can encode it, otherwise JPEG.
 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    let url = canvas.toDataURL('image/webp', quality);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
    if (url.length < 130_000) return url;
  }
  throw new Error('image too large');
}

export async function signOut(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteAccount(): Promise<boolean> {
  try {
    const res = await fetch('/api/me', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

async function postJson<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && json) return { ok: true, data: json as T };
    const err = json?.error as Record<string, unknown> | undefined;
    let message = (err?.message as string) ?? 'Request failed.';
    // Surface validation issues so the user sees what's actually wrong.
    const issues = err?.issues as { path: string; message: string }[] | undefined;
    if (issues?.length) message += ' ' + issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; ');
    return { ok: false, message };
  } catch {
    return { ok: false, message: "Couldn't reach the server." };
  }
}

export interface SessionPreview {
  name: string;
  hostName: string | null;
  expiresAt: string;
  rules: {
    checkInWindowSec: number;
    hostAckWindowSec: number;
    backupAckWindowSec: number;
    locationStaleAfterSec: number;
    heartbeatTimeoutSec: number;
    maxParticipants: number;
    allowLocationSharing: boolean;
    /** Demo only: the public place the host picked for the session. */
    demoVenue?: { label: string; lat: number; lng: number } | null;
  };
}

export async function previewSession(code: string): Promise<SessionPreview | null> {
  const body = await getJson<{ session: SessionPreview }>(`/sessions/join/${encodeURIComponent(code)}`);
  return body?.session ?? null;
}

/** A person's own sharing choices, as the server stores them. */
export interface ServerConsent {
  monitoring: boolean;
  locationSharing: string;
  shareLocationWithResponders: boolean;
  /** Their name and note go to responders (simulated emergency services) during an alert. */
  shareNoteWithResponders?: boolean;
}

export interface ServerParticipant {
  participantId: string;
  displayName: string;
  role: string;
  isYou: boolean;
  deviceOnline: boolean;
}

export interface ServerSessionView {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  rules: SessionPreview['rules'];
  isHost: boolean;
  me: {
    participantId: string;
    role: string;
    joinedAt: string;
    leftAt: string | null;
    consent: ServerConsent;
    backupContacts: { name: string; relation: string }[];
  } | null;
  participants: ServerParticipant[];
  code?: string;
}

export async function createSessionOnServer(input: {
  name: string;
  durationMin: number;
  consent: ServerConsent;
  backupContacts?: { name: string; relation: string }[];
  /** Self-reported note for responders; disclosed only under consent.shareNoteWithResponders. */
  responderNote?: string;
  rules?: Record<string, number | boolean>;
}): Promise<{ session: ServerSessionView; joinUrl: string } | string> {
  const result = await postJson<{ session: ServerSessionView; joinUrl: string }>('/sessions', input);
  return result.ok ? result.data : result.message;
}

export async function joinSessionOnServer(input: {
  code: string;
  consent: ServerConsent;
  backupContacts?: { name: string; relation: string }[];
  /** Self-reported note for responders; disclosed only under consent.shareNoteWithResponders. */
  responderNote?: string;
}): Promise<ServerSessionView | string> {
  const result = await postJson<{ session: ServerSessionView }>('/sessions/join', input);
  return result.ok ? result.data.session : result.message;
}

async function sendJson(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ServerSessionPoll extends Omit<ServerSessionView, 'participants'> {
  participants: (ServerParticipant & { consent?: ServerConsent })[];
}

/** The server's current view of a session, or null when it can't be reached. */
export async function fetchServerSession(serverId: string): Promise<ServerSessionPoll | null> {
  const body = await getJson<{ session: ServerSessionPoll }>(`/sessions/${encodeURIComponent(serverId)}`);
  return body?.session ?? null;
}

export function updateConsentOnServer(
  serverId: string,
  consent: ServerConsent,
): Promise<boolean> {
  return sendJson('PATCH', `/sessions/${encodeURIComponent(serverId)}/me/consent`, consent);
}

export function leaveSessionOnServer(serverId: string): Promise<boolean> {
  return sendJson('POST', `/sessions/${encodeURIComponent(serverId)}/leave`);
}

export function endSessionOnServer(serverId: string): Promise<boolean> {
  return sendJson('POST', `/sessions/${encodeURIComponent(serverId)}/end`);
}

/** A live position from the server's in-memory relay (docs/backend.md, "Live group location"). */
export interface LiveFix {
  participantId: string;
  displayName: string;
  isYou: boolean;
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** A made-up position around the demo venue, not the phone's GPS. */
  simulated?: boolean;
  fixAt: string;
  ageSec: number;
  status: 'live' | 'stale';
}

/** Positions this viewer may see, or null when the server can't be reached. */
export async function fetchLiveLocations(serverId: string): Promise<LiveFix[] | null> {
  const body = await getJson<{ locations: LiveFix[] }>(`/sessions/${encodeURIComponent(serverId)}/locations`);
  return body?.locations ?? null;
}

/** Relays one device fix. The server keeps it in memory only, unless an incident about you is active. */
export function sendLiveLocation(
  serverId: string,
  fix: { latitude: number; longitude: number; accuracyM: number; fixAt: string; simulated?: boolean },
): Promise<boolean> {
  return sendJson('POST', `/sessions/${encodeURIComponent(serverId)}/location`, fix);
}

/** Host only: sets (or with null, clears) the demo venue for the whole session. */
export function setSessionVenueOnServer(serverId: string, venue: { label: string; lat: number; lng: number } | null): Promise<boolean> {
  return sendJson('PATCH', `/sessions/${encodeURIComponent(serverId)}/rules`, { demoVenue: venue });
}

// ---------------------------------------------------------------------------
// Check-ins and alerts (server-backed sessions). The server owns every
// deadline; these calls only report what this device saw and fetch the result.
// ---------------------------------------------------------------------------

/** GET /api/incidents/:id and the timeline's incidents (src/server/alerts/routes.ts, incidentView). */
export interface ServerIncidentView {
  id: string;
  sessionId: string;
  participant: { participantId: string; displayName: string };
  trigger: 'checkin_missed' | 'help_requested';
  openedAt: string;
  status: 'open' | 'acknowledged' | 'resolved';
  nextEscalationAt: string | null;
  acknowledged: { by: string; at: string; note: string } | null;
  resolved: { by: string; at: string; outcome: 'false_alarm' | 'assistance_reached' | 'other' } | null;
  steps: { level: 'host' | 'backup' | 'emergency_simulated'; recipients: string[]; notifiedAt: string | null; dueAt: string | null }[];
  log: { at: string; kind: string; text: string; simulated?: boolean }[];
}

export interface ServerCheckInView {
  id: string;
  status: 'pending' | 'responded_ok' | 'requested_help' | 'missed' | 'cancelled';
  promptedAt: string;
  dueAt: string;
  incidentId: string | null;
}

/** GET /api/alerts: alerts delivered to the signed-in user. */
export interface ServerAlertView {
  id: string;
  incidentId: string;
  about: string;
  trigger: 'checkin_missed' | 'help_requested';
  deliveredAt: string | null;
  incidentStatus: string;
}

export interface ServerTimeline {
  incidents: ServerIncidentView[];
  checkIns: ServerCheckInView[];
}

/** Incidents and your own check-ins in a session, or null when the server can't be reached. */
export async function fetchServerTimeline(serverId: string): Promise<ServerTimeline | null> {
  const body = await getJson<ServerTimeline>(`/sessions/${encodeURIComponent(serverId)}/timeline`);
  return body ? { incidents: body.incidents ?? [], checkIns: body.checkIns ?? [] } : null;
}

export async function fetchServerAlerts(): Promise<ServerAlertView[] | null> {
  const body = await getJson<{ alerts: ServerAlertView[] }>('/alerts');
  return body?.alerts ?? null;
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string; code?: string };

async function postResult<T>(path: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: (json ?? {}) as T };
    const err = json?.error as { code?: string; message?: string } | undefined;
    return { ok: false, message: err?.message ?? 'Request failed.', code: err?.code };
  } catch {
    return { ok: false, message: "Couldn't reach the server." };
  }
}

/** Your device saw a movement change: the server starts your private check-in and its deadline. */
export function startCheckInOnServer(serverId: string): Promise<Result<{ checkIn: ServerCheckInView }>> {
  return postResult(`/sessions/${encodeURIComponent(serverId)}/checkins`, { reason: 'movement_changed' });
}

export function respondCheckInOnServer(checkInId: string, response: 'ok' | 'help'): Promise<Result<{ checkIn: ServerCheckInView; incidentId?: string }>> {
  return postResult(`/checkins/${encodeURIComponent(checkInId)}/respond`, { response });
}

export function requestHelpOnServer(serverId: string): Promise<Result<{ incidentId: string }>> {
  return postResult(`/sessions/${encodeURIComponent(serverId)}/help`, {});
}

export function sendImOkOnServer(serverId: string): Promise<Result<unknown>> {
  return postResult(`/sessions/${encodeURIComponent(serverId)}/update`, {});
}

export function acknowledgeOnServer(alertId: string): Promise<Result<{ incident: ServerIncidentView }>> {
  return postResult(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, {});
}

export function resolveOnServer(incidentId: string, outcome: 'false_alarm' | 'assistance_reached' | 'other'): Promise<Result<{ incident: ServerIncidentView }>> {
  return postResult(`/incidents/${encodeURIComponent(incidentId)}/resolve`, { outcome });
}

/** Mirrors src/server/data/story.ts: what happened, as this viewer may see it. */
export interface ServerStory {
  items: { at: string; kind: 'session' | 'movement' | 'alert'; text: string; participantId?: string }[];
  noMovementRecord: string[];
}

export async function fetchStory(serverId: string): Promise<ServerStory | null> {
  return getJson<ServerStory>(`/sessions/${encodeURIComponent(serverId)}/story`);
}

// ---------------------------------------------------------------------------
// Live incident demo (presenter tool; the server mounts it only in demo mode)
// ---------------------------------------------------------------------------

export type DemoPhase =
  | 'before_impact'
  | 'watching'
  | 'checkin_pending'
  | 'answered_ok'
  | 'incident_open'
  | 'calling'
  | 'on_call'
  | 'acknowledged'
  | 'resolved'
  | 'stopped';

/** Mirrors src/server/demo/live-demo.ts `DemoView`. */
export interface DemoView {
  sessionId: string;
  participantId: string;
  name: string;
  phase: DemoPhase;
  startedAt: string;
  impactAt: string;
  checkIn: { id: string; dueAt: string; status: string } | null;
  incidentId: string | null;
  call: { id: string; status: 'ringing' | 'active' | 'ended' } | null;
  timelineEvents: number;
  rules: { checkInWindowSec: number; hostAckWindowSec: number; backupAckWindowSec: number };
  stoppedReason: string | null;
}

/** The session's demo; null when none has run; 'unavailable' when the server has the demo off. */
export async function fetchDemo(serverId: string): Promise<DemoView | null | 'unavailable'> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(serverId)}/demo`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return 'unavailable';
    return ((await res.json()) as { demo: DemoView | null }).demo;
  } catch {
    return 'unavailable';
  }
}

export function startDemo(serverId: string, participantId: string): Promise<Result<{ demo: DemoView }>> {
  return postResult(`/sessions/${encodeURIComponent(serverId)}/demo`, { participantId });
}

export async function stopDemo(serverId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(serverId)}/demo`, { method: 'DELETE', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

const LOGIN_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'Sign-in expired. Try again.',
  provider_error: "That provider couldn't sign you in. Try again or use another option.",
  unknown_provider: 'That sign-in option is not available.',
  server_error: 'Something went wrong on our end. Please try again.',
};

/** Reads and clears `#login_error=` left by a failed sign-in redirect. */
export function takeLoginError(): string | null {
  const m = window.location.hash.match(/login_error=([a-z_]+)/);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname);
  return LOGIN_ERRORS[m[1]] ?? 'Sign-in failed. Try again.';
}
