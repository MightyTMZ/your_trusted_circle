import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_ORIGIN, hostSession, join, setup, signIn } from "./helpers.js";

test("a signed-in user creates a session and is its host", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const s = await hostSession(maya);
  const view = await maya.call("GET", `/api/sessions/${s.id}`);
  assert.equal(view.body.session.isHost, true);
  assert.match(view.body.session.code, /^[A-Z2-9]{6}$/);
  assert.equal(view.body.session.participants.length, 1);
  assert.equal(view.body.session.participants[0].role, "host");
});

test("session creation validates input", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const consent = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };
  assert.equal((await maya.call("POST", "/api/sessions", { name: "x", durationMin: 29, consent, consentTextVersion: "consent-v1" })).status, 400, "shorter than 30 minutes");
  assert.equal((await maya.call("POST", "/api/sessions", { name: "x", durationMin: 24 * 60 + 1, consent, consentTextVersion: "consent-v1" })).status, 400, "longer than 24 hours");
  assert.equal((await maya.call("POST", "/api/sessions", { name: "x", durationMin: 90.5, consent, consentTextVersion: "consent-v1" })).status, 400, "whole minutes only");
  assert.equal((await maya.call("POST", "/api/sessions", { name: "", durationMin: 240, consent, consentTextVersion: "consent-v1" })).status, 400);
  assert.equal(
    (await maya.call("POST", "/api/sessions", { name: "x", durationMin: 240, consent, consentTextVersion: "consent-v1" })).status,
    400,
    "a backup contact is required",
  );
  assert.equal(
    (
      await maya.call("POST", "/api/sessions", {
        name: "x",
        durationMin: 240,
        consent,
        consentTextVersion: "consent-v1",
        backupContacts: [{ name: "  ", relation: "Friend" }],
      })
    ).status,
    400,
    "whitespace-only contact names are rejected",
  );
  const extra = await maya.call("POST", "/api/sessions", { name: "x", durationMin: 240, consent, consentTextVersion: "consent-v1", hostUserId: "usr_x" });
  assert.equal(extra.status, 400, "unknown fields are rejected");
});

test("the host can set a custom time limit, and the session ends when it says", async () => {
  const { app, advance, tick } = setup();
  const maya = await signIn(app, "maya");
  const consent = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };
  const backupContacts = [{ name: "Rin", relation: "Friend" }];
  const created = await maya.call("POST", "/api/sessions", {
    name: "Short one",
    durationMin: 90,
    consent,
    consentTextVersion: "consent-v1",
    backupContacts,
  });
  assert.equal(created.status, 201, "90 minutes is not one of the old 2/4/6 hour choices");
  const { id, expiresAt, createdAt } = created.body.session;
  assert.equal(new Date(expiresAt).getTime() - new Date(createdAt).getTime(), 90 * 60_000);
  for (const edge of [30, 24 * 60]) {
    assert.equal(
      (await maya.call("POST", "/api/sessions", { name: `edge ${edge}`, durationMin: edge, consent, consentTextVersion: "consent-v1", backupContacts })).status,
      201,
      `${edge} min is allowed`,
    );
  }
  advance(89 * 60_000);
  await tick();
  assert.equal((await maya.call("GET", `/api/sessions/${id}`)).body.session.status, "active");
  advance(2 * 60_000);
  await tick();
  assert.equal((await maya.call("GET", `/api/sessions/${id}`)).body.session.status, "ended");
});

test("the host gets a join code, link and QR; others do not", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const invite = await maya.call("GET", `/api/sessions/${s.id}/invite`);
  assert.equal(invite.status, 200);
  assert.equal(invite.body.joinUrl, `${APP_ORIGIN}/#join=${invite.body.code}`);
  assert.match(invite.body.qrSvg, /^<svg/);

  await join(sam, invite.body.code);
  assert.equal((await sam.call("GET", `/api/sessions/${s.id}/invite`)).status, 403);
  const samView = await sam.call("GET", `/api/sessions/${s.id}`);
  assert.equal(samView.body.session.code, undefined);
  assert.equal(samView.body.session.participants[0].consent, undefined, "participants don't see each other's choices");
});

test("joining by code works for typed and QR codes, case-insensitively, and once", async () => {
  const { app, store } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;

  const preview = await sam.call("GET", `/api/sessions/join/${code.toLowerCase()}`);
  assert.equal(preview.body.session.hostName, "Maya");

  const joined = await join(sam, code.toLowerCase());
  assert.equal(joined.me.participantId.startsWith("par_"), true);
  await join(sam, code);
  assert.equal(store.sessions.get(s.id)!.participants.length, 2, "joining twice does not duplicate");
});

test("an unknown or expired code cannot be joined", async () => {
  const { app, advance } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  const consent = { monitoring: true, locationSharing: "off", shareLocationWithResponders: false };
  const backupContacts = [{ name: "Rin", relation: "Friend" }];
  assert.equal((await sam.call("POST", "/api/sessions/join", { code: "ZZZZZZ", consent, consentTextVersion: "consent-v1", backupContacts })).status, 404);
  advance(5 * 60 * 60 * 1000);
  assert.equal((await sam.call("POST", "/api/sessions/join", { code, consent, consentTextVersion: "consent-v1", backupContacts })).status, 404);
});

test("joining needs a sign-in", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const s = await hostSession(maya);
  maya.cookies.clear();
  const res = await maya.call("GET", `/api/sessions/${s.id}`);
  assert.equal(res.status, 401);
});

test("only the host sets rules; a full session refuses new people", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const jo = await signIn(app, "jo");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);

  assert.equal((await sam.call("PATCH", `/api/sessions/${s.id}/rules`, { maxParticipants: 5 })).status, 403);
  assert.equal((await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { maxParticipants: 1 })).status, 400, "below the minimum");
  assert.equal((await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { maxParticipants: 2 })).status, 200);

  const consent = { monitoring: true, locationSharing: "group", shareLocationWithResponders: true };
  const full = await jo.call("POST", "/api/sessions/join", {
    code,
    consent,
    consentTextVersion: "consent-v1",
    backupContacts: [{ name: "Rin", relation: "Friend" }],
  });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, "session_full");
});

test("turning location off for the session overrides everyone's choice", async () => {
  const { app, store } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  const joined = await join(sam, code);

  await maya.call("PATCH", `/api/sessions/${s.id}/rules`, { allowLocationSharing: false });
  const p = store.sessions.get(s.id)!.participants.find((x) => x.participantId === joined.me.participantId)!;
  assert.equal(p.consent.locationSharing, "off");
  assert.equal(p.consent.shareLocationWithResponders, false);

  const res = await sam.call("PATCH", `/api/sessions/${s.id}/me/consent`, {
    monitoring: true,
    locationSharing: "group",
    shareLocationWithResponders: true,
    consentTextVersion: "consent-v1",
  });
  assert.equal(res.body.session.me.consent.locationSharing, "off");
});

test("each person changes only their own consent", async () => {
  const { app, store } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);
  await sam.call("PATCH", `/api/sessions/${s.id}/me/consent`, {
    monitoring: false,
    locationSharing: "off",
    shareLocationWithResponders: false,
    consentTextVersion: "consent-v1",
  });
  const ps = store.sessions.get(s.id)!.participants;
  assert.equal(ps.find((p) => p.role === "participant")!.consent.monitoring, false);
  assert.equal(ps.find((p) => p.role === "host")!.consent.monitoring, true);
});

test("participants leave; the host ends instead", async () => {
  const { app } = setup();
  const maya = await signIn(app, "maya");
  const sam = await signIn(app, "sam");
  const s = await hostSession(maya);
  const code = (await maya.call("GET", `/api/sessions/${s.id}`)).body.session.code as string;
  await join(sam, code);
  assert.equal((await maya.call("POST", `/api/sessions/${s.id}/leave`)).status, 409);
  assert.equal((await sam.call("POST", `/api/sessions/${s.id}/leave`)).status, 204);
  assert.equal((await sam.call("POST", `/api/sessions/${s.id}/end`)).status, 403);
  assert.equal((await maya.call("POST", `/api/sessions/${s.id}/end`)).status, 204);
  assert.equal((await maya.call("GET", `/api/sessions/${s.id}`)).body.session.status, "ended");
});
