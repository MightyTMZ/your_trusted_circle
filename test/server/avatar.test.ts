import { test } from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MAX_BYTES } from "../../src/server/data/avatar.js";
import { setup, signIn } from "./helpers.js";

// A real 1×1 PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a profile picture can be set, read back, exported and removed", async () => {
  const { app } = setup();
  const sam = await signIn(app, "sam");
  assert.equal((await sam.call("GET", "/api/me")).body.user.avatar, null, "no picture until one is set");

  const set = await sam.call("PATCH", "/api/me", { avatar: PNG });
  assert.equal(set.status, 200);
  assert.equal(set.body.user.avatar, PNG);
  assert.equal((await sam.call("GET", "/api/me")).body.user.avatar, PNG);

  const exported = (await (await sam.raw("GET", "/api/me/export")).json()) as any;
  assert.equal(exported.user.avatar, PNG, "the export includes the picture");

  const removed = await sam.call("PATCH", "/api/me", { avatar: null });
  assert.equal(removed.body.user.avatar, null);
});

test("changing the name leaves the picture alone, and vice versa", async () => {
  const { app } = setup();
  const sam = await signIn(app, "sam");
  await sam.call("PATCH", "/api/me", { avatar: PNG });
  const renamed = await sam.call("PATCH", "/api/me", { displayName: "  Sam K.  " });
  assert.equal(renamed.body.user.displayName, "Sam K.");
  assert.equal(renamed.body.user.avatar, PNG);
});

test("only real, small PNG, JPEG or WebP images are accepted", async () => {
  const { app } = setup();
  const sam = await signIn(app, "sam");
  const reject = async (avatar: unknown) => (await sam.call("PATCH", "/api/me", { avatar })).status;

  assert.equal(await reject("https://example.com/me.png"), 400, "no remote URLs");
  assert.equal(await reject("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), 400, "no SVG (it can carry script)");
  assert.equal(await reject(`data:image/png;base64,${Buffer.from("not an image").toString("base64")}`), 400, "bytes must match the type");
  const big = Buffer.alloc(AVATAR_MAX_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
  assert.equal(await reject(`data:image/png;base64,${big.toString("base64")}`), 400, "too large");
  assert.equal(await reject(42), 400);
  assert.equal((await sam.call("PATCH", "/api/me", {})).status, 400, "an empty change is refused");
  assert.equal((await sam.call("GET", "/api/me")).body.user.avatar, null, "nothing was stored");
});
