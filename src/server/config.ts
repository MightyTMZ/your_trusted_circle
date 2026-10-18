/**
 * Server configuration from environment variables. A provider is enabled
 * only when all of its credentials are present; secrets never leave the
 * server and are never logged.
 */
import type { ProviderId, SessionRules } from "./types.js";

export interface ProviderCredentials {
  google?: { clientId: string; clientSecret: string };
  apple?: { clientId: string; teamId: string; keyId: string; privateKeyPem: string };
  microsoft?: { clientId: string; clientSecret: string; tenant: string };
}

export interface ServerConfig {
  port: number;
  mongoUri: string | null;
  mongoDb: string;
  /** Origin of the web app, e.g. http://localhost:5173. Used for CSRF checks, CORS and redirects. */
  appOrigin: string;
  /** Public origin of this API, used to build OAuth redirect URIs. */
  apiOrigin: string;
  /** Secure cookies. Must be true outside local http development. */
  secureCookies: boolean;
  authSessionTtlMs: number;
  providers: ProviderCredentials;
  defaultRules: SessionRules;
  /** Shortest and longest session a host may start, in minutes. Mirrors src/domain/config.ts. */
  minDurationMin: number;
  maxDurationMin: number;
  /** Alert delivery: attempts before giving up, and the wait before each retry. */
  alertMaxAttempts: number;
  alertRetryDelaysMs: readonly number[];
  /** How long a worker owns a job it is sending before another may retry it. */
  alertLeaseMs: number;
  /** Traces and finished sessions older than this are deleted. */
  retentionDays: number;
  /** Run retention inside the API. Turn off once the Python pruning pipeline (pipelines/) runs. */
  retentionInApi: boolean;
  /** Voice-agent service (box 4). Both unset: the emergency step is recorded as simulated only. */
  voiceAgentUrl: string | null;
  /** Shared secret the voice-agent service uses for /api/service/*. */
  voiceAgentToken: string | null;
  /** Vercel Cron sends this as a bearer token to /api/internal/tick. */
  cronSecret: string | null;
  /** Serverless hosts: run a scheduler pass (at most once a second) before handling requests. */
  tickOnRequest: boolean;
  /** Read the client IP from X-Forwarded-For (only behind a proxy you control, e.g. Vercel). */
  trustProxy: boolean;
  /**
   * Password-free test sign-in for trying the app with several made-up people
   * on one computer. Only ever on for a localhost app origin outside production.
   */
  testSignIn: boolean;
  /**
   * The presenter's live incident demo (demo/): synthetic sensor input that
   * runs the real check-in, escalation and simulated call. On with
   * DEMO_INCIDENTS=true, or with the localhost test sign-in.
   */
  demoIncidents: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for http(s)://localhost, 127.0.0.1 or [::1] on any port. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Mirrors src/domain/config.ts. All values are unvalidated demo defaults. */
export const DEFAULT_RULES: SessionRules = {
  checkInWindowSec: 60,
  hostAckWindowSec: 120,
  backupAckWindowSec: 180,
  locationStaleAfterSec: 90,
  heartbeatTimeoutSec: 120,
  maxParticipants: 20,
  allowLocationSharing: true,
};

function pick(env: NodeJS.ProcessEnv, ...keys: string[]): string[] | null {
  const values = keys.map((k) => env[k]?.trim() ?? "");
  return values.every((v) => v.length > 0) ? values : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? 8787);
  const appOrigin = (env.APP_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
  const apiOrigin = (env.API_ORIGIN ?? appOrigin).replace(/\/$/, "");
  const providers: ProviderCredentials = {};

  const google = pick(env, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  if (google) providers.google = { clientId: google[0]!, clientSecret: google[1]! };

  const apple = pick(env, "APPLE_CLIENT_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY");
  if (apple) {
    providers.apple = {
      clientId: apple[0]!,
      teamId: apple[1]!,
      keyId: apple[2]!,
      // .env files usually hold the PEM on one line with literal \n.
      privateKeyPem: apple[3]!.replace(/\\n/g, "\n"),
    };
  }

  const microsoft = pick(env, "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET");
  if (microsoft) {
    providers.microsoft = {
      clientId: microsoft[0]!,
      clientSecret: microsoft[1]!,
      tenant: env.MICROSOFT_TENANT?.trim() || "common",
    };
  }

  const testSignIn = env.TEST_SIGN_IN === "true" && env.NODE_ENV !== "production" && isLocalUrl(appOrigin) && isLocalUrl(apiOrigin);
  return {
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    mongoUri: env.MONGODB_URI?.trim() || null,
    mongoDb: env.MONGODB_DB?.trim() || "ytc",
    appOrigin,
    apiOrigin,
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : appOrigin.startsWith("https://"),
    testSignIn,
    demoIncidents: env.DEMO_INCIDENTS === "true" || testSignIn,
    authSessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    providers,
    defaultRules: DEFAULT_RULES,
    minDurationMin: 30,
    maxDurationMin: 24 * 60,
    alertMaxAttempts: 5,
    alertRetryDelaysMs: [5_000, 15_000, 45_000, 120_000],
    alertLeaseMs: 30_000,
    retentionDays: Number(env.RETENTION_DAYS ?? 30) || 30,
    retentionInApi: env.RETENTION_IN_API !== "false",
    voiceAgentUrl: env.VOICE_AGENT_URL?.trim().replace(/\/$/, "") || null,
    voiceAgentToken: env.VOICE_AGENT_TOKEN?.trim() || null,
    cronSecret: env.CRON_SECRET?.trim() || null,
    tickOnRequest: env.TICK_ON_REQUEST === "true",
    trustProxy: env.TRUST_PROXY === "true",
  };
}

export function enabledProviders(config: ServerConfig): ProviderId[] {
  return (Object.keys(config.providers) as ProviderId[]).filter((p) => config.providers[p] !== undefined);
}
