import assert from "node:assert/strict";
import { defaultTransport, type Transport } from "../../src/server/alerts/transport.js";
import { createApp } from "../../src/server/app.js";
import type { OAuthProvider, ProviderRegistry } from "../../src/server/auth/providers.js";
import { loadConfig } from "../../src/server/config.js";
import type { Deps } from "../../src/server/context.js";
import { createDeps } from "../../src/server/deps.js";
import { runSchedulerPass } from "../../src/server/safety/scheduler.js";
import { MemoryStore } from "../../src/server/store/memory.js";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import { Timeline, type Provenance } from "../../src/timeline/index.js";

export const APP_ORIGIN = "http://app.test";
export const T0 = Date.UTC(2026, 9, 17, 22, 0, 0, 0);

/** Stands in for Google: the authorization code is the user's subject. */
const fakeGoogle: OAuthProvider = {
  id: "google",
  formPost: false,
  authorizationUrl: (state) => new URL(`https://accounts.example/authorize?state=${state}`),
  identify: async ({ code }) => ({
    subject: code,
    email: `${code}@example.test`,
    emailVerified: true,
    displayName: code.charAt(0).toUpperCase() + code.slice(1),
  }),
};

export function setup(transport: Transport = defaultTransport, env: Record<string, string> = {}) {
  const store = new MemoryStore();
  let nowMs = T0;
  const config = loadConfig({ APP_ORIGIN, ...env } as NodeJS.ProcessEnv);
  const providers: ProviderRegistry = { google: fakeGoogle };
  // strictTimeline: any event the server records must pass the catalog, or the test fails.
  const deps: Deps = createDeps(config, store, { providers, transport, now: () => new Date(nowMs), strictTimeline: true });
  const app = createApp(deps);
  return {
    app,
    store,
    deps,
    advance: (ms: number) => void (nowMs += ms),
    /** One scheduler pass at the current fake time, as main.ts runs every second. */
    tick: () => runSchedulerPass(deps),
  };
}

type App = ReturnType<typeof setup>["app"];

/** A browser: keeps cookies and sends the app's Origin on writes. */
export class Client {
  readonly cookies = new Map<string, string>();
  constructor(private readonly app: App) {}

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h = new Headers(headers);
    if (this.cookies.size > 0) h.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (method !== "GET" && !h.has("Origin")) h.set("Origin", APP_ORIGIN);
    const init: RequestInit = { method, headers: h };
    if (body !== undefined) {
      h.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    const res = await this.app.request(`http://api.test${path}`, init);
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(setCookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
}

export async function signIn(app: App, subject: string): Promise<Client> {
  const client = new Client(app);
  const start = await client.raw("GET", "/api/auth/google/start?returnTo=/tonight");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state");
  const callback = await client.raw("GET", `/api/auth/google/callback?code=${subject}&state=${state}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), `${APP_ORIGIN}/tonight`);
  assert.ok(client.cookies.has("ytc_session"));
  return client;
}

export async function hostSession(host: Client, consent = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true }) {
  const res = await host.call("POST", "/api/sessions", { name: "Friday at Ridgeway Hall", durationMin: 240, consent, consentTextVersion: "consent-v1" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.session as { id: string; code: string; me: { participantId: string } };
}

export async function join(client: Client, code: string, consent = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true }) {
  const res = await client.call("POST", "/api/sessions/join", { code, consent, consentTextVersion: "consent-v1" });
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  return res.body.session as { id: string; me: { participantId: string } };
}

export const UI: Provenance = { component: "ui", data_origin: "synthetic_scenario", simulated: false };

/** A client-side timeline for one session, producing events the server will validate. */
export function timeline(sessionId: string) {
  return new Timeline({ sessionId, clock: new ManualClock(T0), ids: new SequentialIds() });
}

export function locationFix(t: Timeline, participantId: string) {
  return t.append({
    type: "location.reported",
    participant_id: participantId,
    actor: { kind: "participant", id: participantId },
    provenance: { component: "sensor_adapter", data_origin: "synthetic_scenario", simulated: false },
    data: {
      latitude: 43.6532,
      longitude: -79.3832,
      accuracy_m: 12,
      fix_at: "2026-10-17T22:00:00.000Z",
      source: "synthetic",
      speed_m_s: 0,
      heading_deg: null,
    },
  });
}
