/**
 * Signed-in state. The browser holds a random 256-bit token in an httpOnly
 * cookie; the database holds only its SHA-256, so a database leak does not
 * hand out working sessions.
 */
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { fail, type AppEnv, type Deps } from "../context.js";
import { newToken, sha256 } from "../ids.js";

export const SESSION_COOKIE = "ytc_session";

export async function startAuthSession(c: Context, deps: Deps, userId: string): Promise<void> {
  const token = newToken();
  const now = deps.now();
  await deps.store.insertAuthSession({
    _id: sha256(token),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + deps.config.authSessionTtlMs),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(deps.config.authSessionTtlMs / 1000),
  });
}

export async function endAuthSession(c: Context, deps: Deps): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deps.store.deleteAuthSession(sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: deps.config.secureCookies });
}

/** Rejects the request with 401 unless it carries a live sign-in. Sets c.var.user. */
export function requireAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return fail(c, 401, "not_signed_in", "Sign in to continue.");
    const tokenHash = sha256(token);
    const session = await deps.store.getAuthSession(tokenHash);
    if (!session || session.expiresAt.getTime() <= deps.now().getTime()) {
      if (session) await deps.store.deleteAuthSession(tokenHash);
      return fail(c, 401, "not_signed_in", "Your sign-in has expired. Sign in again.");
    }
    const user = await deps.store.getUser(session.userId);
    if (!user) return fail(c, 401, "not_signed_in", "Sign in to continue.");
    c.set("user", user);
    c.set("tokenHash", tokenHash);
    await next();
  };
}
