import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/shared/clock.js";
import { SequentialIds } from "../../src/shared/ids.js";
import {
  JsonlFileSink,
  Timeline,
  canonicalJson,
  parseJsonl,
  readTimelineFile,
  timelineFromJsonl,
  toJsonl,
} from "../../src/timeline/index.js";

const T0 = Date.UTC(2026, 9, 17, 23, 0, 0, 0);

function sample(sinks = [] as JsonlFileSink[]) {
  const timeline = new Timeline({ sessionId: "ses_0001", clock: new ManualClock(T0), ids: new SequentialIds(), sinks });
  for (const p of ["par_0001", "par_0002"]) {
    timeline.append({
      type: "session.participant_joined",
      participant_id: p,
      actor: { kind: "participant", id: p },
      provenance: { component: "session_manager", data_origin: "system_generated", simulated: false },
      data: { role: "member", joined_via: "qr_code" },
    });
  }
  return timeline;
}

test("canonicalJson sorts keys recursively and rejects non-finite numbers", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ x: Number.NaN }), TypeError);
});

test("JSONL lines put identity, time and summary before detail", () => {
  const line = toJsonl(sample().events).split("\n")[0]!;
  const keys = Object.keys(JSON.parse(line));
  assert.deepEqual(keys.slice(0, 3), ["schema_version", "seq", "event_id"]);
  assert.ok(keys.indexOf("summary") < keys.indexOf("data"));
  assert.equal(keys.at(-1), "hash");
});

test("toJsonl and timelineFromJsonl round-trip", () => {
  const original = sample();
  const text = toJsonl(original.events);
  assert.equal(text.split("\n").length, 3);
  const restored = timelineFromJsonl(text, { sessionId: "ses_0001", clock: new ManualClock(T0) });
  assert.deepEqual(restored.events, original.events);
});

test("parseJsonl skips blank lines and reports truncated ones by line number", () => {
  const text = toJsonl(sample().events);
  const truncated = `${text}\n${text.split("\n")[0]!.slice(0, 40)}`;
  const { records, errors } = parseJsonl(truncated);
  assert.equal(records.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.line, 4);
  assert.throws(() => timelineFromJsonl(truncated, { sessionId: "ses_0001", clock: new ManualClock(T0) }), /line 4/);
});

test("JsonlFileSink appends lines that readTimelineFile can restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "ypc-timeline-"));
  try {
    const path = join(dir, "nested", "ses_0001.jsonl");
    const sink = new JsonlFileSink(path);
    const original = sample([sink]);
    sink.close();
    assert.equal(readFileSync(path, "utf8"), toJsonl(original.events));
    const restored = readTimelineFile(path, { sessionId: "ses_0001", clock: new ManualClock(T0) });
    assert.equal(restored.headHash, original.headHash);
    assert.throws(() => sink.write(original.events[0]!, "{}"), /closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
