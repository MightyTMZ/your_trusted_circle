/**
 * The localhost-only test sign-in: off by default, never on for a public
 * origin or in production, and refused for requests not addressed to localhost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { createDeps } from "../../src/server/deps.js";
import { MemoryStore } from "../../src/server/store/memory.js";

const LOCAL = "http://localhost:5173";

function app(env: Record<string, string>) {
  const config = loadConfig(env as NodeJS.ProcessEnv);
  const deps = createDeps(config, new MemoryStore(), { providers: {}, strictTimeline: true });
  return { app: createApp(deps), config };
}

async function signIn(a: ReturnType<typeof app>["app"], name: string, host = "localhost:5173") {
  const res = await a.request("http://localhost:5173/api/auth/test/signin", {
    method: "POST",
    headers: { Host: host, Origin: LOCAL, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ytc_session="))?.split(";")[0];
  return { status: res.status, cookie };
}

test("only on when asked for, on a localhost origin, outside production", () => {
  assert.equal(loadConfig({ APP_ORIGIN: LOCAL } as NodeJS.ProcessEnv).testSignIn, false);
  assert.equal(loadConfig({ APP_ORIGIN: LOCAL, TEST_SIGN_IN: "true" } as NodeJS.ProcessEnv).testSignIn, true);
  assert.equal(loadConfig({ APP_ORIGIN: "https://ytc.example", TEST_SIGN_IN: "true" } as NodeJS.ProcessEnv).testSignIn, false);
  assert.equal(loadConfig({ APP_ORIGIN: LOCAL, TEST_SIGN_IN: "true", NODE_ENV: "production" } as NodeJS.ProcessEnv).testSignIn, false);
  assert.equal(
    loadConfig({ APP_ORIGIN: LOCAL, API_ORIGIN: "https://api.example", TEST_SIGN_IN: "true" } as NodeJS.ProcessEnv).testSignIn,
    false,
  );
});

test("a made-up name signs in, and the same name returns the same account", async () => {
  const { app: a } = app({ APP_ORIGIN: LOCAL, TEST_SIGN_IN: "true" });
  const first = await signIn(a, "Sam Test");
  assert.equal(first.status, 204);
  assert.ok(first.cookie);
  const me = (await (await a.request("http://localhost:5173/api/me", { headers: { Cookie: first.cookie! } })).json()) as any;
  assert.equal(me.user.displayName, "Sam Test");
  const again = await signIn(a, "sam test");
  const me2 = (await (await a.request("http://localhost:5173/api/me", { headers: { Cookie: again.cookie! } })).json()) as any;
  assert.equal(me2.user.id, me.user.id);
});

test("refused when off, for another host, or without a name", async () => {
  assert.equal((await signIn(app({ APP_ORIGIN: LOCAL }).app, "Sam")).status, 404);
  const { app: a } = app({ APP_ORIGIN: LOCAL, TEST_SIGN_IN: "true" });
  assert.equal((await signIn(a, "Sam", "ytc.example")).status, 404);
  assert.equal((await signIn(a, "  ")).status, 400);
  const providers = (await (await a.request("http://localhost:5173/api/auth/providers")).json()) as any;
  assert.equal(providers.testSignIn, true);
});
