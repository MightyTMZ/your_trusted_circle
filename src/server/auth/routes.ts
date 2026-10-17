/**
 * GET  /api/auth/providers            which sign-in buttons to show
 * GET  /api/auth/:provider/start      redirect to the provider
 * GET|POST /api/auth/:provider/callback  provider redirects back; signs the user in
 * POST /api/auth/logout               ends this browser's sign-in
 *
 * Accounts are keyed by provider + subject. Two providers with the same email
 * are NOT merged automatically: doing so would let anyone who controls an
 * unverified address at one provider take over the account.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { generateCodeVerifier, generateState } from "arctic";
import type { AppEnv, Deps } from "../context.js";
import { newId } from "../ids.js";
import { PROVIDER_IDS, type ProviderId, type UserDoc } from "../types.js";
import { IdentityError, type ProviderIdentity } from "./providers.js";
import { endAuthSession, startAuthSession } from "./session.js";

const OAUTH_COOKIE = "ytc_oauth";
const OAUTH_COOKIE_PATH = "/api/auth";

interface PendingLogin {
  p: ProviderId;
  s: string; // state
  v: string; // PKCE code verifier
  r: string; // where to send the user afterwards (app-relative path)
}

/** Only same-app paths, so the callback cannot be used as an open redirect. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value.slice(0, 512);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readPending(raw: string | undefined): PendingLogin | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingLogin;
    return PROVIDER_IDS.includes(p.p) && typeof p.s === "string" && typeof p.v === "string" && typeof p.r === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}

export async function findOrCreateUser(deps: Deps, provider: ProviderId, identity: ProviderIdentity): Promise<UserDoc> {
  const now = deps.now();
  const existing = await deps.store.findUserByIdentity(provider, identity.subject);
  if (existing) {
    // Keep the user's chosen display name; refresh the contact email only.
    if (identity.email && (identity.email !== existing.email || identity.emailVerified !== existing.emailVerified)) {
      await deps.store.updateUser(existing._id, { email: identity.email, emailVerified: identity.emailVerified }, now);
    }
    return (await deps.store.getUser(existing._id))!;
  }
  const user: UserDoc = {
    _id: newId("usr"),
    displayName: identity.displayName ?? "YTC user",
    email: identity.email,
    emailVerified: identity.emailVerified,
    identities: [{ provider, subject: identity.subject, linkedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  await deps.store.insertUser(user);
  return user;
}

export function authRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const appUrl = (path: string) => `${deps.config.appOrigin}${path}`;
  const failRedirect = (reason: string) => appUrl(`/#login_error=${encodeURIComponent(reason)}`);

  r.get("/providers", (c) => c.json({ providers: PROVIDER_IDS.filter((p) => deps.providers[p]) }));

  r.get("/:provider/start", (c) => {
    const provider = deps.providers[c.req.param("provider") as ProviderId];
    if (!provider) return c.json({ error: { code: "unknown_provider", message: "That sign-in option is not available." } }, 404);
    const pending: PendingLogin = {
      p: provider.id,
      s: generateState(),
      v: generateCodeVerifier(),
      r: safeReturnTo(c.req.query("returnTo")),
    };
    // Apple's cross-site form POST only carries SameSite=None cookies, which require HTTPS.
    const crossSite = provider.formPost && deps.config.secureCookies;
    setCookie(c, OAUTH_COOKIE, JSON.stringify(pending), {
      httpOnly: true,
      secure: deps.config.secureCookies,
      sameSite: crossSite ? "None" : "Lax",
      path: OAUTH_COOKIE_PATH,
      maxAge: 600,
    });
    return c.redirect(provider.authorizationUrl(pending.s, pending.v).toString(), 302);
  });

  r.on(["GET", "POST"], "/:provider/callback", async (c) => {
    const providerId = c.req.param("provider") as ProviderId;
    const provider = deps.providers[providerId];
    const pending = readPending(getCookie(c, OAUTH_COOKIE));
    deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH, secure: deps.config.secureCookies });

    const params: Record<string, string> = {};
    if (c.req.method === "POST") {
      const body = await c.req.parseBody();
      for (const [k, v] of Object.entries(body)) if (typeof v === "string") params[k] = v;
    } else {
      Object.assign(params, c.req.query());
    }

    if (!provider) return c.redirect(failRedirect("unknown_provider"), 302);
    if (params.error) return c.redirect(failRedirect("cancelled"), 302);
    if (!pending || pending.p !== providerId || !params.state || !sameSecret(params.state, pending.s) || !params.code) {
      return c.redirect(failRedirect("invalid_state"), 302);
    }

    let identity: ProviderIdentity;
    try {
      identity = await provider.identify({ code: params.code, codeVerifier: pending.v, form: params });
    } catch (err) {
      // Never echo provider error bodies to the browser; they can contain tokens.
      console.warn(`[auth] ${providerId} sign-in failed: ${err instanceof IdentityError ? err.message : "token exchange failed"}`);
      return c.redirect(failRedirect("provider_error"), 302);
    }

    const user = await findOrCreateUser(deps, providerId, identity);
    await startAuthSession(c, deps, user._id);
    return c.redirect(appUrl(pending.r), 302);
  });

  r.post("/logout", async (c) => {
    await endAuthSession(c, deps);
    return c.body(null, 204);
  });

  return r;
}
