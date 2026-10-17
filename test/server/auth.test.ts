import { test } from "node:test";
import assert from "node:assert/strict";
import { safeReturnTo } from "../../src/server/auth/routes.js";
import { APP_ORIGIN, Client, setup, signIn } from "./helpers.js";

test("lists only configured sign-in providers", async () => {
  const { app } = setup();
  const res = await new Client(app).call("GET", "/api/auth/providers");
  assert.deepEqual(res.body, { providers: ["google"] });
});

test("unknown provider is refused", async () => {
  const { app } = setup();
  const res = await new Client(app).raw("GET", "/api/auth/myspace/start");
  assert.equal(res.status, 404);
});

test("protected routes need a sign-in", async () => {
  const { app } = setup();
  const res = await new Client(app).call("GET", "/api/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "not_signed_in");
});

test("sign-in creates the user once and stores only a hash of the session token", async () => {
  const { app, store } = setup();
  const alice = await signIn(app, "alice");
  const me = await alice.call("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.displayName, "Alice");
  assert.deepEqual(me.body.user.providers, ["google"]);

  const token = alice.cookies.get("ytc_session")!;
  assert.ok(!store.authSessions.has(token), "raw token must not be stored");
  assert.equal(store.authSessions.size, 1);

  await signIn(app, "alice");
  assert.equal(store.users.size, 1, "second sign-in reuses the account");
});

test("a tampered state is rejected", async () => {
  const { app, store } = setup();
  const client = new Client(app);
  await client.raw("GET", "/api/auth/google/start");
  const res = await client.raw("GET", "/api/auth/google/callback?code=mallory&state=forged");
  assert.equal(res.headers.get("Location"), `${APP_ORIGIN}/#login_error=invalid_state`);
  assert.equal(store.users.size, 0);
});

test("a callback without the state cookie is rejected", async () => {
  const { app } = setup();
  const res = await new Client(app).raw("GET", "/api/auth/google/callback?code=mallory&state=x");
  assert.equal(res.headers.get("Location"), `${APP_ORIGIN}/#login_error=invalid_state`);
});

test("returnTo cannot redirect off the app", () => {
  assert.equal(safeReturnTo("//evil.example/x"), "/");
  assert.equal(safeReturnTo("https://evil.example"), "/");
  assert.equal(safeReturnTo("/\\evil.example"), "/");
  assert.equal(safeReturnTo("/tonight?x=1"), "/tonight?x=1");
});

test("logout ends the sign-in", async () => {
  const { app, store } = setup();
  const alice = await signIn(app, "alice");
  const out = await alice.raw("POST", "/api/auth/logout");
  assert.equal(out.status, 204);
  assert.equal(store.authSessions.size, 0);
  assert.equal((await alice.call("GET", "/api/me")).status, 401);
});

test("an expired sign-in is refused", async () => {
  const { app, advance } = setup();
  const alice = await signIn(app, "alice");
  advance(31 * 24 * 60 * 60 * 1000);
  assert.equal((await alice.call("GET", "/api/me")).status, 401);
});

test("writes from another origin, or without one, are blocked", async () => {
  const { app } = setup();
  const alice = await signIn(app, "alice");
  const evil = await alice.raw("PATCH", "/api/me", { displayName: "Hacked" }, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const form = await alice.raw("POST", "/api/sessions", undefined, { "Content-Type": "text/plain" });
  assert.notEqual(form.status, 201);
});
