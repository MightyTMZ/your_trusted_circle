/**
 * Adapter for phyphox exports (https://phyphox.org): "Acceleration (with g)"
 * and "Linear Acceleration (without g)" experiments, CSV format.
 *
 * An export directory contains:
 *   Raw Data.csv    "Time (s)", "<Linear >Acceleration x|y|z (m/s^2)", "Absolute acceleration (m/s^2)"
 *   meta/time.csv   START/PAUSE events: experiment time (s) <-> system time (epoch s)
 *   meta/device.csv sensor name, range, resolution, min delay (optional)
 *
 * Time (s) is relative to the experiment; time.csv anchors it to wall-clock
 * time, segment by segment, because pausing stops the experiment clock.
 *
 * Structural problems (no time column, no START event) throw a
 * PhyphoxFormatError: nothing can be anchored. Row-level problems are
 * skipped and reported in `issues`; MotionStream then validates every
 * sample again, so a bad file can lose data but never corrupt it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STANDARD_GRAVITY_M_S2 } from "./features.js";
import type { Sample } from "./stream.js";

export class PhyphoxFormatError extends Error {
  override name = "PhyphoxFormatError";
}

export interface PhyphoxRecording {
  /** Which OS sensor produced the data. */
  sensor: "accelerometer" | "linear_acceleration";
  gravityIncluded: boolean;
  /** Absolute samples (epoch ms), in file order. */
  samples: Sample[];
  /** Epoch ms of the first START event. */
  startedAt: number;
  segments: { experimentStartS: number; systemStartMs: number; experimentEndS: number | null }[];
  device: {
    model: string | null;
    sensorName: string | null;
    rangeM_s2: number | null;
    resolutionM_s2: number | null;
    /** Fastest supported sample period, µs. */
    minDelayUs: number | null;
  };
  /** Rows that could not be used, with 1-based line numbers. */
  issues: { line: number; message: string }[];
}

/** Reads an export directory such as `examples/accelerometer/With g`. */
export function readPhyphoxExport(dir: string): PhyphoxRecording {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  let device: string | undefined;
  try {
    device = read("meta/device.csv");
  } catch {
    device = undefined;
  }
  return parsePhyphoxExport(read("Raw Data.csv"), read("meta/time.csv"), device);
}

export function parsePhyphoxExport(rawCsv: string, timeCsv: string, deviceCsv?: string): PhyphoxRecording {
  const raw = parseCsv(rawCsv);
  const header = raw.rows[0];
  if (!header) throw new PhyphoxFormatError("Raw Data.csv is empty");

  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const tCol = find(/^time\b/i);
  const axisCol = (axis: string) => find(new RegExp(`acceleration ${axis}\\b`, "i"));
  const cols = [axisCol("x"), axisCol("y"), axisCol("z")];
  if (tCol < 0 || cols.some((c) => c < 0)) {
    throw new PhyphoxFormatError(`Raw Data.csv needs Time and Acceleration x/y/z columns; found: ${header.join(", ")}`);
  }
  const linear = cols.every((c) => /linear/i.test(header[c]!));
  // phyphox reports m/s^2; convert if an export ever states g.
  const scale = cols.every((c) => /\(g\)/i.test(header[c]!)) ? STANDARD_GRAVITY_M_S2 : 1;
  const timeScale = /\(ms\)/i.test(header[tCol]!) ? 0.001 : 1;

  const segments = parseSegments(timeCsv);
  const issues: PhyphoxRecording["issues"] = [];
  const samples: Sample[] = [];
  let seg = 0;
  for (let r = 1; r < raw.rows.length; r++) {
    const row = raw.rows[r]!;
    const line = raw.lines[r]!;
    const values = [tCol, ...cols].map((c) => toNumber(row[c], raw.decimalComma));
    if (values.some((v) => v === null)) {
      issues.push({ line, message: "non-numeric or missing value" });
      continue;
    }
    const [tS, x, y, z] = values as number[];
    const ts = tS! * timeScale;
    // Segments are ordered; advance to the one containing this experiment time.
    while (seg + 1 < segments.length && ts >= segments[seg + 1]!.experimentStartS) seg++;
    const s = segments[seg]!;
    if (ts < s.experimentStartS) {
      issues.push({ line, message: "time before the first START event" });
      continue;
    }
    samples.push({ t: s.systemStartMs + (ts - s.experimentStartS) * 1000, x: x! * scale, y: y! * scale, z: z! * scale });
  }

  const meta = deviceCsv ? parseDevice(deviceCsv) : new Map<string, string>();
  const prefix = linear ? "linear_acceleration" : "accelerometer";
  const num = (key: string) => toNumber(meta.get(`${prefix} ${key}`), false);
  return {
    sensor: linear ? "linear_acceleration" : "accelerometer",
    gravityIncluded: !linear,
    samples,
    startedAt: segments[0]!.systemStartMs,
    segments,
    device: {
      model: meta.get("deviceModel") ?? null,
      sensorName: meta.get(`${prefix} Name`) ?? null,
      rangeM_s2: num("Range"),
      resolutionM_s2: num("Resolution"),
      minDelayUs: num("MinDelay"),
    },
    issues,
  };
}

function parseSegments(timeCsv: string): PhyphoxRecording["segments"] {
  const { rows, decimalComma } = parseCsv(timeCsv);
  const segments: PhyphoxRecording["segments"] = [];
  for (const row of rows.slice(1)) {
    const event = row[0]?.toUpperCase();
    const experiment = toNumber(row[1], decimalComma);
    const system = toNumber(row[2], decimalComma);
    if (experiment === null || system === null) continue;
    if (event === "START") segments.push({ experimentStartS: experiment, systemStartMs: Math.round(system * 1000), experimentEndS: null });
    if (event === "PAUSE" && segments.length > 0) segments[segments.length - 1]!.experimentEndS = experiment;
  }
  if (segments.length === 0) throw new PhyphoxFormatError("meta/time.csv has no START event; samples cannot be anchored in time");
  return segments;
}

function parseDevice(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of parseCsv(csv).rows.slice(1)) {
    if (row[0] && row[1] !== undefined && row[1] !== "null" && row[1] !== "") map.set(row[0], row[1]);
  }
  return map;
}

/**
 * Small CSV reader for phyphox's export variants: comma, tab or semicolon
 * delimited (semicolon exports use decimal commas), quoted fields, BOM, CRLF.
 */
function parseCsv(text: string): { rows: string[][]; lines: number[]; decimalComma: boolean } {
  const all = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = all.find((l) => l.trim() !== "") ?? "";
  const delimiter = [",", "\t", ";"].reduce((best, d) => (first.split(d).length > first.split(best).length ? d : best), ",");
  const rows: string[][] = [];
  const lines: number[] = [];
  all.forEach((l, i) => {
    if (l.trim() === "") return;
    rows.push(splitRow(l, delimiter));
    lines.push(i + 1);
  });
  return { rows, lines, decimalComma: delimiter === ";" };
}

function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(field.trim());
      field = "";
    } else field += c;
  }
  out.push(field.trim());
  return out;
}

function toNumber(value: string | undefined, decimalComma: boolean): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(decimalComma ? value.replace(",", ".") : value);
  return Number.isFinite(n) ? n : null;
}
