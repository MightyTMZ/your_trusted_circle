import { test } from "node:test";
import assert from "node:assert/strict";
import { ManualClock, parseIso, toIso } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";

test("ManualClock advances and refuses to go backwards", () => {
  const clock = new ManualClock(1_000);
  assert.equal(clock.advance(500), 1_500);
  clock.set(2_000);
  assert.equal(clock.now(), 2_000);
  assert.throws(() => clock.set(1_999), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
});

test("toIso and parseIso round-trip at millisecond precision", () => {
  const ms = Date.UTC(2026, 9, 17, 23, 41, 5, 120);
  const iso = toIso(ms);
  assert.equal(iso, "2026-10-17T23:41:05.120Z");
  assert.equal(parseIso(iso), ms);
});

test("parseIso rejects non-canonical timestamps", () => {
  assert.equal(parseIso("2026-10-17T23:41:05Z"), null);
  assert.equal(parseIso("2026-10-17 23:41:05.120Z"), null);
  assert.equal(parseIso("2026-10-17T23:41:05.120+01:00"), null);
});

test("SequentialIds counts per prefix", () => {
  const ids = new SequentialIds();
  assert.equal(ids.next("evt"), "evt_0001");
  assert.equal(ids.next("evt"), "evt_0002");
  assert.equal(ids.next("inc"), "inc_0001");
});
