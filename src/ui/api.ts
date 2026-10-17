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
  };
}

export async function previewSession(code: string): Promise<SessionPreview | null> {
  const body = await getJson<{ session: SessionPreview }>(`/sessions/join/${encodeURIComponent(code)}`);
  return body?.session ?? null;
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
    consent: { monitoring: boolean; locationSharing: string; shareLocationWithResponders: boolean };
    backupContacts: { name: string; relation: string }[];
  } | null;
  participants: ServerParticipant[];
  code?: string;
}

export async function createSessionOnServer(input: {
  name: string;
  durationMin: number;
  consent: { monitoring: boolean; locationSharing: string; shareLocationWithResponders: boolean };
  backupContacts?: { name: string; relation: string }[];
  rules?: Record<string, number | boolean>;
}): Promise<{ session: ServerSessionView; joinUrl: string } | string> {
  const result = await postJson<{ session: ServerSessionView; joinUrl: string }>('/sessions', input);
  return result.ok ? result.data : result.message;
}

export async function joinSessionOnServer(input: {
  code: string;
  consent: { monitoring: boolean; locationSharing: string; shareLocationWithResponders: boolean };
  backupContacts?: { name: string; relation: string }[];
}): Promise<ServerSessionView | string> {
  const result = await postJson<{ session: ServerSessionView }>('/sessions/join', input);
  return result.ok ? result.data.session : result.message;
}

// ---------------------------------------------------------------------------
// Check-in / safety API
// ---------------------------------------------------------------------------

export interface ServerCheckInView {
  id: string;
  sessionId: string;
  reason: string;
  promptedAt: string;
  dueAt: string;
  status: string;
  respondedAt: string | null;
  incidentId: string | null;
}

/** Tell the server a movement change was detected and a check-in should start. */
export async function createCheckInOnServer(
  sessionId: string,
  reason: 'movement_changed' | 'manual',
): Promise<ServerCheckInView | null> {
  const result = await postJson<{ checkIn: ServerCheckInView }>(`/sessions/${sessionId}/checkins`, { reason });
  return result.ok ? result.data.checkIn : null;
}

/** Respond to a server-side check-in. */
export async function respondToCheckInOnServer(
  checkInId: string,
  response: 'ok' | 'help',
): Promise<{ checkIn: ServerCheckInView; incidentId?: string } | null> {
  const result = await postJson<{ checkIn: ServerCheckInView; incidentId?: string }>(`/checkins/${checkInId}/respond`, { response });
  return result.ok ? result.data : null;
}

/** Ask for help directly (no preceding check-in). */
export async function requestHelpOnServer(
  sessionId: string,
): Promise<{ incidentId: string } | null> {
  const result = await postJson<{ incidentId: string }>(`/sessions/${sessionId}/help`, {});
  return result.ok ? result.data : null;
}

/** Send a heartbeat so the server knows the device is alive. */
export async function sendHeartbeat(sessionId: string): Promise<boolean> {
  const result = await postJson<void>(`/sessions/${sessionId}/heartbeat`, {});
  return result.ok;
}

/** Tell responders "I'm OK" (logged only, does not close the alert). */
export async function sendParticipantUpdate(sessionId: string): Promise<boolean> {
  const result = await postJson<void>(`/sessions/${sessionId}/update`, {});
  return result.ok;
}

/** Cancel my own open alert as a false alarm. Only works for an alert about me. */
export async function cancelOwnAlertOnServer(sessionId: string): Promise<boolean> {
  const result = await postJson<void>(`/sessions/${sessionId}/cancel-alert`, {});
  return result.ok;
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
