/**
 * OAuth sign-in with Google, Apple and Microsoft (Entra ID, personal and work
 * accounts). GitHub sign-in is deliberately not offered. Each provider turns
 * an authorization code into a stable identity (provider + subject). Access
 * and refresh tokens are used once and never stored.
 *
 * ID tokens arrive straight from the provider's token endpoint over TLS, so
 * per OpenID Connect Core 3.1.3.7 the signature check may be skipped; issuer,
 * audience and expiry are still checked here.
 */
import { Apple, Google, MicrosoftEntraId, decodeIdToken } from "arctic";
import type { ServerConfig } from "../config.js";
import type { ProviderId } from "../types.js";

export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

export interface CallbackInput {
  code: string;
  codeVerifier: string;
  /** Apple sends the user's name only once, as a form field on the first sign-in. */
  form?: Record<string, string>;
}

export interface OAuthProvider {
  readonly id: ProviderId;
  /** Apple returns to the callback with a cross-site POST (response_mode=form_post). */
  readonly formPost: boolean;
  authorizationUrl(state: string, codeVerifier: string): URL;
  identify(input: CallbackInput): Promise<ProviderIdentity>;
}

export type ProviderRegistry = Partial<Record<ProviderId, OAuthProvider>>;

export class IdentityError extends Error {}

type Claims = Record<string, unknown>;

function checkClaims(claims: Claims, issuer: (iss: string) => boolean, audience: string, nowMs: number): Claims {
  const { iss, aud, exp, sub } = claims;
  if (typeof iss !== "string" || !issuer(iss)) throw new IdentityError("ID token issuer is not trusted");
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(audience)) throw new IdentityError("ID token was issued for another app");
  if (typeof exp !== "number" || exp * 1000 <= nowMs) throw new IdentityError("ID token has expired");
  if (typeof sub !== "string" || sub.length === 0) throw new IdentityError("ID token has no subject");
  return claims;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
// Apple sends email_verified as the string "true".
const truthy = (v: unknown) => v === true || v === "true";

function pemToPkcs8(pem: string): Uint8Array {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export function createProviders(config: ServerConfig, now: () => Date = () => new Date()): ProviderRegistry {
  const callback = (id: ProviderId) => `${config.apiOrigin}/api/auth/${id}/callback`;
  const registry: ProviderRegistry = {};
  const { google, apple, microsoft } = config.providers;

  if (google) {
    const client = new Google(google.clientId, google.clientSecret, callback("google"));
    registry.google = {
      id: "google",
      formPost: false,
      authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]),
      async identify({ code, codeVerifier }) {
        const tokens = await client.validateAuthorizationCode(code, codeVerifier);
        const c = checkClaims(
          decodeIdToken(tokens.idToken()) as Claims,
          (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
          google.clientId,
          now().getTime(),
        );
        return { subject: c.sub as string, email: str(c.email), emailVerified: truthy(c.email_verified), displayName: str(c.name) };
      },
    };
  }

  if (microsoft) {
    const client = new MicrosoftEntraId(microsoft.tenant, microsoft.clientId, microsoft.clientSecret, callback("microsoft"));
    const tenantIssuer = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/;
    const fixedTenant = /^[0-9a-f-]{36}$/.test(microsoft.tenant) ? microsoft.tenant : null;
    registry.microsoft = {
      id: "microsoft",
      formPost: false,
      authorizationUrl: (state, verifier) => client.createAuthorizationURL(state, verifier, ["openid", "profile", "email"]),
      async identify({ code, codeVerifier }) {
        const tokens = await client.validateAuthorizationCode(code, codeVerifier);
        const c = checkClaims(
          decodeIdToken(tokens.idToken()) as Claims,
          (iss) => {
            const m = tenantIssuer.exec(iss);
            return m !== null && (fixedTenant === null || m[1] === fixedTenant);
          },
          microsoft.clientId,
          now().getTime(),
        );
        // Microsoft does not assert that email addresses are verified.
        return { subject: c.sub as string, email: str(c.email), emailVerified: false, displayName: str(c.name) };
      },
    };
  }

  if (apple) {
    const client = new Apple(apple.clientId, apple.teamId, apple.keyId, pemToPkcs8(apple.privateKeyPem), callback("apple"));
    registry.apple = {
      id: "apple",
      formPost: true,
      authorizationUrl: (state) => {
        const url = client.createAuthorizationURL(state, ["name", "email"]);
        url.searchParams.set("response_mode", "form_post");
        return url;
      },
      async identify({ code, form }) {
        const tokens = await client.validateAuthorizationCode(code);
        const c = checkClaims(
          decodeIdToken(tokens.idToken()) as Claims,
          (iss) => iss === "https://appleid.apple.com",
          apple.clientId,
          now().getTime(),
        );
        let displayName: string | null = null;
        try {
          const user = JSON.parse(form?.user ?? "{}") as { name?: { firstName?: string; lastName?: string } };
          displayName = str([user.name?.firstName, user.name?.lastName].filter(Boolean).join(" "));
        } catch {
          // Missing or malformed: the name is optional.
        }
        return { subject: c.sub as string, email: str(c.email), emailVerified: truthy(c.email_verified), displayName };
      },
    };
  }

  return registry;
}
