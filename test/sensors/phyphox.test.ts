import { test } from "node:test";
import assert from "node:assert/strict";
import { PhyphoxFormatError, parsePhyphoxExport, readPhyphoxExport } from "../../src/sensors/phyphox.js";
import { MotionStream } from "../../src/sensors/stream.js";
import { DEFAULT_FEATURE_CONFIG, windowFeatures } from "../../src/sensors/features.js";

const WITH_G = "examples/accelerometer/With g";
const WITHOUT_G = "examples/accelerometer/Without g";
const TIME = '"event","experiment time","system time","system time text"\n"START",0.000000000E0,1792193484.030,"x"\n';

test("reads the With g export as gravity-included samples anchored to wall-clock time", () => {
  const rec = readPhyphoxExport(WITH_G);
  assert.equal(rec.sensor, "accelerometer");
  assert.equal(rec.gravityIncluded, true);
  assert.equal(rec.samples.length, 20_365);
  assert.equal(rec.issues.length, 0);
  assert.equal(new Date(rec.startedAt).toISOString(), "2026-10-16T23:31:24.030Z");
  assert.ok(Math.abs(rec.samples[0]!.t - (rec.startedAt + 9.235432)) < 1e-6);
  assert.deepEqual(rec.device, {
    model: "Pixel 9",
    sensorName: "ICM45631 Accelerometer",
    rangeM_s2: 156.9064,
    resolutionM_s2: 5.985504e-4,
    minDelayUs: 2500,
  });
});

test("reads the Without g export as linear acceleration", () => {
  const rec = readPhyphoxExport(WITHOUT_G);
  assert.equal(rec.sensor, "linear_acceleration");
  assert.equal(rec.gravityIncluded, false);
  assert.equal(rec.samples.length, 1_433);
  assert.equal(rec.device.sensorName, "Linear Acceleration Sensor");
});

test("the real With g recording: vigorous shaking, a clipped impact, then settling down", () => {
  const rec = readPhyphoxExport(WITH_G);
  const cfg = { ...DEFAULT_FEATURE_CONFIG, windowMs: 10_000, sensorRangeM_s2: rec.device.rangeM_s2! };
  const stream = new MotionStream({ windowMs: 10_000 });
  const windows = [...stream.pushMany(rec.samples), ...stream.flush(rec.samples.at(-1)!.t + 60_000)];
  assert.equal(stream.stats.accepted, rec.samples.length, "no sample lost at 400 Hz");
  let previous: number[] | null = null;
  const features = windows.map((w) => {
    const f = windowFeatures(w, cfg, previous);
    previous = f.gravity_vector_m_s2;
    return f;
  });
  assert.deepEqual(features.map((f) => f.activity_level), ["vigorous", "vigorous", "vigorous", "vigorous", "moderate", "moderate"]);
  const clipped = features.flatMap((f) => f.impacts).filter((i) => i.clipped);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0]!.at, "2026-10-16T23:31:52.617Z");
  assert.ok(features[0]!.coverage_ratio < 0.7, "first window only partly covered by the recording");
  assert.ok(features[2]!.tilt_change_deg! > 90, "phone rotated during the shaking");
});

test("semicolon exports with decimal commas parse the same", () => {
  const csv = '"Time (s)";"Acceleration x (m/s^2)";"Acceleration y (m/s^2)";"Acceleration z (m/s^2)"\r\n0,5;0,1;9,8;0,2\r\n';
  const rec = parsePhyphoxExport(`﻿${csv}`, TIME);
  assert.equal(rec.samples.length, 1);
  assert.deepEqual(rec.samples[0], { t: 1792193484030 + 500, x: 0.1, y: 9.8, z: 0.2 });
});

test("bad rows are skipped with line numbers; structural problems throw clearly", () => {
  const header = '"Time (s)","Acceleration x (m/s^2)","Acceleration y (m/s^2)","Acceleration z (m/s^2)"\n';
  const rec = parsePhyphoxExport(`${header}0.1,0,9.8,0\nnot,a,row\n0.2,0,9.8\n0.3,0,9.8,0\n`, TIME);
  assert.equal(rec.samples.length, 2);
  assert.deepEqual(rec.issues.map((i) => i.line), [3, 4]);
  assert.throws(() => parsePhyphoxExport('"Time (s)","Pressure (hPa)"\n0,1000\n', TIME), PhyphoxFormatError);
  assert.throws(() => parsePhyphoxExport(`${header}0.1,0,9.8,0\n`, '"event"\n'), /no START/);
});

test("pause/resume segments map experiment time onto the right wall-clock time", () => {
  const header = '"Time (s)","Acceleration x (m/s^2)","Acceleration y (m/s^2)","Acceleration z (m/s^2)"\n';
  const time = '"event","experiment time","system time"\n"START",0,1000\n"PAUSE",10,1010\n"START",10,2000\n';
  const rec = parsePhyphoxExport(`${header}5,0,9.8,0\n12,0,9.8,0\n`, time);
  assert.deepEqual(rec.samples.map((s) => s.t), [1_005_000, 2_002_000]);
});
