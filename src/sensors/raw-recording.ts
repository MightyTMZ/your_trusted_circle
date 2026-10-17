/**
 * Raw sensor recordings, stored apart from the timeline.
 *
 * Why separate: an accelerometer at 50 Hz is ~180k samples/hour/person.
 * Keeping every sample lets later analysis recompute or improve features,
 * but putting them in the timeline would bury the events responders need.
 * The timeline holds derived windows that point back here via raw_ref.
 *
 * Format: JSONL, one batch per line. Samples are columnar rows
 * `[offset_ms, ...channel values]` described once by `channels`, which is
 * several times smaller than one object per sample.
 */
import { parseIso, toIso } from "../shared/clock.js";
import { DATA_ORIGINS } from "../timeline/schema/envelope.js";
import { v, validate, type Infer } from "../timeline/schema/validate.js";

export const RAW_SCHEMA_VERSION = "1.0" as const;

/** Channel layout per stream. Units are fixed so every consumer reads values the same way. */
export const STREAMS = {
  /** Device frame, gravity included (what the OS reports as accelerometer, not linear acceleration). */
  accelerometer: [
    { name: "x", unit: "m/s^2" },
    { name: "y", unit: "m/s^2" },
    { name: "z", unit: "m/s^2" },
  ],
  /** OS linear acceleration: gravity already removed (phyphox "without g"). */
  linear_acceleration: [
    { name: "x", unit: "m/s^2" },
    { name: "y", unit: "m/s^2" },
    { name: "z", unit: "m/s^2" },
  ],
  /** Fixes with OS-reported velocity; speed and heading come from GNSS, not integrated acceleration. */
  location: [
    { name: "latitude", unit: "deg" },
    { name: "longitude", unit: "deg" },
    { name: "accuracy", unit: "m" },
    { name: "speed", unit: "m/s" },
    { name: "heading", unit: "deg" },
  ],
} as const;
export type StreamName = keyof typeof STREAMS;

const headerSchema = v.object({
  schema_version: v.literal(RAW_SCHEMA_VERSION),
  recording_id: v.id("rec"),
  batch_seq: v.number({ min: 1, integer: true }),
  session_id: v.id("ses"),
  participant_id: v.id("par"),
  stream: v.enum(["accelerometer", "linear_acceleration", "location"] as const),
  /** Nominal rate; null for event-driven streams such as location. */
  sample_rate_hz: v.nullable(v.number({ min: 0 })),
  started_at: v.timestamp(),
  channels: v.array(v.object({ name: v.string(), unit: v.string() }), { minLength: 1 }),
  device_kind: v.enum(["phone", "wearable", "synthetic"] as const),
  data_origin: v.enum(DATA_ORIGINS),
  samples: v.unknown(),
});

export type RawBatch = Omit<Infer<typeof headerSchema>, "samples"> & { samples: number[][] };

export interface RawRecorderOptions {
  recordingId: string;
  sessionId: string;
  participantId: string;
  stream: StreamName;
  sampleRateHz: number | null;
  deviceKind: RawBatch["device_kind"];
  dataOrigin: RawBatch["data_origin"];
  /** Receives each serialized batch line (no trailing newline), e.g. a file appender. */
  write: (line: string) => void;
}

/** Appends validated batches for one participant and stream. */
export class RawRecorder {
  private seq = 0;

  constructor(private readonly opts: RawRecorderOptions) {}

  append(startedAtMs: number, samples: number[][]): RawBatch {
    const batch: RawBatch = {
      schema_version: RAW_SCHEMA_VERSION,
      recording_id: this.opts.recordingId,
      batch_seq: this.seq + 1,
      session_id: this.opts.sessionId,
      participant_id: this.opts.participantId,
      stream: this.opts.stream,
      sample_rate_hz: this.opts.sampleRateHz,
      started_at: toIso(startedAtMs),
      channels: STREAMS[this.opts.stream].map((c) => ({ ...c })),
      device_kind: this.opts.deviceKind,
      data_origin: this.opts.dataOrigin,
      samples,
    };
    const problems = checkBatch(batch);
    if (problems.length > 0) throw new Error(`Invalid raw batch: ${problems.join("; ")}`);
    this.opts.write(JSON.stringify(batch));
    this.seq += 1;
    return batch;
  }
}

/** Stable pointer from a timeline event to one raw batch: "rec_0001#3". */
export function rawRef(batch: Pick<RawBatch, "recording_id" | "batch_seq">): string {
  return `${batch.recording_id}#${batch.batch_seq}`;
}

export function findBatch(batches: readonly RawBatch[], ref: string): RawBatch | undefined {
  const [recordingId, seq] = ref.split("#");
  return batches.find((b) => b.recording_id === recordingId && b.batch_seq === Number(seq));
}

/** Parses and validates raw JSONL; throws with the line number of the first bad batch. */
export function parseRawBatches(text: string): RawBatch[] {
  const batches: RawBatch[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`Raw recording line ${i + 1}: ${(err as Error).message}`);
    }
    const problems = checkBatch(parsed);
    if (problems.length > 0) throw new Error(`Raw recording line ${i + 1}: ${problems.join("; ")}`);
    batches.push(parsed as RawBatch);
  });
  return batches;
}

function checkBatch(raw: unknown): string[] {
  const issues = validate(headerSchema, raw).map((i) => `${i.path} ${i.message}`);
  if (issues.length > 0) return issues;
  const batch = raw as RawBatch;
  const expected = STREAMS[batch.stream];
  if (JSON.stringify(batch.channels) !== JSON.stringify(expected)) {
    return [`channels must be ${expected.map((c) => `${c.name}(${c.unit})`).join(", ")}`];
  }
  if (!Array.isArray(batch.samples) || batch.samples.length === 0) return ["samples must be a non-empty array"];
  if (parseIso(batch.started_at) === null) return ["started_at invalid"];
  // Rows are checked by hand: the generic validator is too slow for tens of thousands of numbers.
  let previous = -1;
  for (let r = 0; r < batch.samples.length; r++) {
    const row = batch.samples[r];
    if (!Array.isArray(row) || row.length !== expected.length + 1) {
      return [`samples[${r}] must be [offset_ms, ${expected.map((c) => c.name).join(", ")}]`];
    }
    if (!row.every((n) => typeof n === "number" && Number.isFinite(n))) return [`samples[${r}] has a non-finite value`];
    const offset = row[0]!;
    if (!Number.isInteger(offset) || offset < previous || offset < 0) {
      return [`samples[${r}] offset_ms must be a non-decreasing, non-negative integer`];
    }
    previous = offset;
  }
  return [];
}
