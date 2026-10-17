/**
 * Sensor pipeline: untrusted samples in, timeline events out.
 *
 *   samples -> MotionStream -> RawRecorder (raw store)
 *                           -> windowFeatures -> sensor.motion_window
 *                           -> BaselineDetector -> sensor.baseline_calibrated / sensor.motion_anomaly_observed
 *                           -> PatternDetector  -> sensor.motion_pattern_observed
 *   time    -> tick()      -> closes silent windows, sensor.stream_interrupted / stream_resumed
 *
 * Guarantees:
 * - Consent first: without "monitoring" consent a window is discarded
 *   before anything (raw or derived) is written.
 * - Never throws on sensor input. A timeline refusal (e.g. consent revoked
 *   between check and append) is counted, not propagated; programming
 *   errors still throw.
 * - Constant memory regardless of session length.
 */
import type { Clock } from "../shared/clock.js";
import { Timeline, TimelineError } from "../timeline/timeline.js";
import type { DataOrigin, Provenance } from "../timeline/schema/envelope.js";
import type { EventType, PayloadOf, TimelineEvent } from "../timeline/schema/catalog.js";
import { BaselineDetector, type BaselineConfig } from "../detector/baseline.js";
import { PatternDetector, type PatternConfig } from "../detector/patterns.js";
import { DEFAULT_FEATURE_CONFIG, windowFeatures, type FeatureConfig } from "./features.js";
import { RawRecorder, rawRef } from "./raw-recording.js";
import { MotionStream, REJECT_REASONS, type ClosedWindow, type StreamOptions } from "./stream.js";

export interface SensorSource {
  sensor: "accelerometer" | "linear_acceleration";
  deviceKind: "phone" | "wearable" | "synthetic";
  deviceModel?: string | null;
  sensorName?: string | null;
  dataOrigin: DataOrigin;
  scenarioId?: string;
}

export interface SensorPipelineOptions {
  timeline: Timeline;
  clock: Clock;
  participantId: string;
  recordingId: string;
  source: SensorSource;
  /** Receives raw batch lines for the raw store (e.g. a file appender). */
  rawWrite: (line: string) => void;
  features?: Partial<FeatureConfig>;
  stream?: Partial<StreamOptions>;
  baseline?: Partial<BaselineConfig>;
  patterns?: Partial<PatternConfig>;
  /** Silence longer than this logs sensor.stream_interrupted. Default: two windows. */
  interruptAfterMs?: number;
}

const PRODUCER = "ypc-motion@0.2.0";

export class SensorPipeline {
  readonly features: FeatureConfig;
  private readonly stream: MotionStream;
  private readonly raw: RawRecorder;
  private readonly baseline: BaselineDetector;
  private readonly patterns: PatternDetector;
  private readonly interruptAfterMs: number;
  private previousGravity: number[] | null = null;
  private interruptedAt: { lastSample: number } | null = null;
  private seenSampleAt: number | null = null;
  private readonly counters = { windows: 0, discardedWindows: 0, refused: 0, lastRefusal: null as string | null };

  constructor(private readonly opts: SensorPipelineOptions) {
    this.features = {
      ...DEFAULT_FEATURE_CONFIG,
      gravityIncluded: opts.source.sensor === "accelerometer",
      ...opts.features,
    };
    this.stream = new MotionStream({ windowMs: this.features.windowMs, ...opts.stream });
    this.baseline = new BaselineDetector(opts.baseline);
    this.patterns = new PatternDetector(opts.patterns);
    this.interruptAfterMs = opts.interruptAfterMs ?? 2 * this.features.windowMs;
    this.raw = new RawRecorder({
      recordingId: opts.recordingId,
      sessionId: opts.timeline.sessionId,
      participantId: opts.participantId,
      stream: opts.source.sensor,
      sampleRateHz: this.features.nominalRateHz,
      deviceKind: opts.source.deviceKind,
      dataOrigin: opts.source.dataOrigin,
      write: opts.rawWrite,
    });
  }

  /** Logs the stream's sensor and thresholds. Call once, after consent. */
  start(): TimelineEvent | null {
    const f = this.features;
    const b = this.baseline.config;
    const p = this.patterns.config;
    return this.append("sensor.stream_started", {
      recording_id: this.opts.recordingId,
      sensor: this.opts.source.sensor,
      gravity_included: f.gravityIncluded,
      device_kind: this.opts.source.deviceKind,
      device_model: this.opts.source.deviceModel ?? null,
      sensor_name: this.opts.source.sensorName ?? null,
      sensor_range_m_s2: f.sensorRangeM_s2,
      nominal_rate_hz: f.nominalRateHz,
      window_ms: f.windowMs,
      features: {
        still_m_s2: f.stillM_s2,
        impact_m_s2: f.impactM_s2,
        moderate_m_s2: f.moderateM_s2,
        vigorous_m_s2: f.vigorousM_s2,
        still_window_ratio: f.stillWindowRatio,
      },
      detector: {
        calibration_windows: b.calibrationWindows,
        min_coverage: b.minCoverage,
        anomaly_z: b.anomalyZ,
        min_stillness_ratio: b.minStillnessRatio,
        refractory_ms: b.refractoryMs,
        impact_still_within_ms: p.impactStillWithinMs,
        prolonged_still_ms: p.prolongedStillMs,
        tilt_change_deg: p.tiltChangeDeg,
      },
      thresholds_validated: false,
    });
  }

  /** Feeds untrusted samples. Returns the events this produced, in order. */
  ingest(samples: Iterable<unknown>): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    const closed = this.stream.pushMany(samples, this.opts.clock.now());
    this.noteResume(out);
    for (const w of closed) out.push(...this.process(w));
    return out;
  }

  /** Call periodically (e.g. every few seconds): closes windows of a silent device and detects interruptions. */
  tick(): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    const now = this.opts.clock.now();
    for (const w of this.stream.flush(now)) out.push(...this.process(w));
    const last = this.stream.lastSampleAt;
    if (last !== null && !this.interruptedAt && now - last > this.interruptAfterMs) {
      this.interruptedAt = { lastSample: last };
      const e = this.append("sensor.stream_interrupted", { last_sample_at: new Date(last).toISOString(), reason: "unknown" }, now);
      if (e) out.push(e);
    }
    return out;
  }

  get stats() {
    return { ...this.counters, stream: this.stream.stats, buffered: this.stream.bufferedSamples };
  }

  private noteResume(out: TimelineEvent[]): void {
    const last = this.stream.lastSampleAt;
    if (last === null || last === this.seenSampleAt) return;
    this.seenSampleAt = last;
    if (!this.interruptedAt) return;
    const gap = Math.max(0, Math.round(last - this.interruptedAt.lastSample));
    this.interruptedAt = null;
    const e = this.append("sensor.stream_resumed", { gap_ms: gap });
    if (e) out.push(e);
  }

  private process(w: ClosedWindow): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    if (!this.opts.timeline.hasConsent(this.opts.participantId, "monitoring")) {
      this.counters.discardedWindows += 1;
      return out;
    }
    const batch = this.raw.append(w.start, w.samples.map((s) => [s.t - w.start, s.x, s.y, s.z]));
    const f = windowFeatures(w, this.features, this.previousGravity);
    this.previousGravity = f.gravity_vector_m_s2;
    const rejected = REJECT_REASONS.reduce((n, r) => n + w.rejected[r], 0);
    const window = this.append(
      "sensor.motion_window",
      { window_start: iso(w.start), window_end: iso(w.end), rejected_sample_count: rejected, ...f },
      w.end,
      [],
      rawRef(batch),
    );
    if (!window) return out;
    this.counters.windows += 1;
    out.push(window);
    const obs = { event_id: window.event_id, data: window.data };

    const { baseline, anomaly } = this.baseline.observe(obs);
    if (baseline) {
      const e = this.append(
        "sensor.baseline_calibrated",
        {
          window_start: baseline.window_start,
          window_end: baseline.window_end,
          window_ms: this.features.windowMs,
          sampling_rate_hz: this.features.nominalRateHz ?? f.effective_rate_hz ?? 0,
          device_kind: this.opts.source.deviceKind,
          features: baseline.features,
        },
        w.end,
        baseline.window_event_ids,
      );
      if (e) out.push(e);
    }
    if (anomaly) {
      const e = this.append("sensor.motion_anomaly_observed", anomaly.data, w.end, [anomaly.window_event_id]);
      if (e) out.push(e);
    }
    for (const p of this.patterns.observe(obs)) {
      const e = this.append("sensor.motion_pattern_observed", p.data, w.end, p.window_event_ids);
      if (e) out.push(e);
    }
    return out;
  }

  private append<T extends EventType>(
    type: T,
    data: PayloadOf<T>,
    occurredAt?: number,
    causedBy: string[] = [],
    raw_ref?: string,
  ): TimelineEvent<T> | null {
    const provenance: Provenance = {
      component: type === "sensor.motion_window" || type.startsWith("sensor.stream") ? "sensor_adapter" : "detector",
      data_origin: this.opts.source.dataOrigin,
      simulated: false,
      producer: PRODUCER,
      ...(this.opts.source.scenarioId ? { scenario_id: this.opts.source.scenarioId } : {}),
      ...(raw_ref ? { raw_ref } : {}),
    };
    try {
      return this.opts.timeline.append({
        type,
        data,
        participant_id: this.opts.participantId,
        occurred_at: Math.min(occurredAt ?? this.opts.clock.now(), this.opts.clock.now()),
        actor: { kind: provenance.component === "detector" ? "detector" : "system", id: null },
        provenance,
        caused_by: [...new Set(causedBy)],
      });
    } catch (err) {
      if (!(err instanceof TimelineError)) throw err;
      this.counters.refused += 1;
      this.counters.lastRefusal = err.message;
      return null;
    }
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
