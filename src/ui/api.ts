/**
 * Calls to the YTC server (docs/backend.md). Every helper tolerates the server
 * being absent: it returns null or false, and screens show that sign-in and
 * account features are unavailable instead of pretending they worked.
 */

export const PROVIDERS = ['google', 'apple', 'microsoft'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google',
  apple: 'Apple',
  microsoft: 'Microsoft',
};

export interface Account {
  id: string;
  displayName: string;
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

const LOGIN_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'Sign-in expired. Try again.',
  provider_error: "That provider couldn't sign you in. Try again or use another option.",
  unknown_provider: 'That sign-in option is not available.',
};

/** Reads and clears `#login_error=` left by a failed sign-in redirect. */
export function takeLoginError(): string | null {
  const m = window.location.hash.match(/login_error=([a-z_]+)/);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname);
  return LOGIN_ERRORS[m[1]] ?? 'Sign-in failed. Try again.';
}
