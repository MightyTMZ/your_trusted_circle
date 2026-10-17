/**
 * Synthetic "No response" + "Unacknowledged alert" scenario (KAZE brief
 * scenarios 2 and 5). All identities, places and readings are invented.
 *
 * Motion data flows the way it will in the app: a synthetic accelerometer
 * produces raw samples -> RawRecorder stores them -> features are computed
 * from the stored batch -> a sensor.motion_window event cites it via
 * raw_ref. Motion windows are shown for calibration (23:02-23:07) and the
 * run-up to the incident (23:47-23:52); a live session emits them
 * continuously.
 *
 * The anomaly is computed with an inline z-score as a stand-in for the
 * detector module, which does not exist yet.
 *
 * `npm run examples` regenerates docs/examples/ from this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { ManualClock, toIso } from "../../shared/clock.js";
import { SequentialIds } from "../../shared/ids.js";
import { RawRecorder, rawRef } from "../../sensors/raw-recording.js";
import { STANDARD_GRAVITY_M_S2, accelerometerFeatures, baselineFrom, round } from "../../sensors/features.js";
import { MOCK_OPERATOR_ENDPOINT_ID, type ConsentScope, type Provenance } from "../schema/envelope.js";
import type { TimelineEvent } from "../schema/catalog.js";
import { Timeline } from "../timeline.js";
import { toJsonl } from "../jsonl.js";
import { buildOperatorBriefing } from "../briefing.js";

export const FIXTURE_SESSION_ID = "ses_0001";
export const FIXTURE_INCIDENT_ID = "inc_0001";
export const FIXTURE_START_MS = Date.UTC(2026, 9, 17, 23, 0, 0, 0);

const HOST = "par_0001";
const SAM = "par_0002";
const ALEX = "par_0003";
const BACKUP = "con_0001";
const SCENARIO = "no-response-v2";
const RATE_HZ = 10;
const WINDOW_MS = 60_000;

const at = (m: number, s = 0) => FIXTURE_START_MS + m * 60_000 + s * 1000;
const prov = (component: Provenance["component"], extra: Partial<Provenance> = {}): Provenance => ({
  component,
  data_origin: "synthetic_scenario",
  simulated: false,
  scenario_id: SCENARIO,
  ...extra,
});
const simulated = (component: Provenance["component"]) => prov(component, { simulated: true });

/** Deterministic PRNG so the example files are reproducible byte for byte. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gravity directions in the device frame: upright in a pocket vs. lying flat. */
const IN_POCKET = unit([0.0, 9.5, 2.43]);
const FLAT = unit([0.25, 0.3, 9.8]);

function unit(v: [number, number, number]): [number, number, number] {
  const k = STANDARD_GRAVITY_M_S2 / Math.hypot(...v);
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** One window of accelerometer rows: gravity + rhythmic movement of `amplitude` + noise. */
function synthWindow(rand: () => number, gravity: [number, number, number], amplitude: number, noise: number) {
  const rows: number[][] = [];
  for (let i = 0; i < (WINDOW_MS / 1000) * RATE_HZ; i++) {
    const t = i / RATE_HZ;
    const sway = amplitude * Math.sin(2 * Math.PI * 1.9 * t + rand() * 0.3);
    const n = () => (rand() - 0.5) * 2 * noise;
    rows.push([
      i * (1000 / RATE_HZ),
      +(gravity[0] + 0.3 * sway + n()).toFixed(3),
      +(gravity[1] + 0.8 * sway + n()).toFixed(3),
      +(gravity[2] + 0.5 * sway + n()).toFixed(3),
    ]);
  }
  return rows;
}

export function buildNoResponseScenario() {
  const clock = new ManualClock(FIXTURE_START_MS);
  const timeline = new Timeline({ sessionId: FIXTURE_SESSION_ID, clock, ids: new SequentialIds() });
  const rawLines: string[] = [];
  const recorder = new RawRecorder({
    recordingId: "rec_0001",
    sessionId: FIXTURE_SESSION_ID,
    participantId: SAM,
    stream: "accelerometer",
    sampleRateHz: RATE_HZ,
    deviceKind: "synthetic",
    dataOrigin: "synthetic_scenario",
    write: (line) => rawLines.push(line),
  });
  const rand = mulberry32(17);
  const tick = (ms: number) => clock.set(ms);

  /** Record one raw window ending at `endMs` and log its features. */
  const motionWindow = (endMs: number, gravity: [number, number, number], amplitude: number, noise: number) => {
    tick(endMs);
    const batch = recorder.append(endMs - WINDOW_MS, synthWindow(rand, gravity, amplitude, noise));
    const { window_ms: _w, ...features } = accelerometerFeatures(batch, { windowMs: WINDOW_MS, stillThresholdM_s2: 0.15 });
    return timeline.append({
      type: "sensor.motion_window",
      participant_id: SAM,
      occurred_at: endMs,
      actor: { kind: "detector", id: null },
      provenance: prov("sensor_adapter", { raw_ref: rawRef(batch), producer: "accel-features@0.1.0" }),
      data: { window_start: toIso(endMs - WINDOW_MS), window_end: toIso(endMs), ...features },
    });
  };

  // ── 23:00 Session setup. Each person opts in for themselves. ───────────
  timeline.append({
    type: "session.created",
    participant_id: HOST,
    actor: { kind: "host", id: HOST },
    provenance: prov("session_manager"),
    data: {
      expires_at: toIso(FIXTURE_START_MS + 6 * 3_600_000),
      checkin_response_window_ms: 120_000,
      escalation_steps: [
        { step: 1, target_role: "host", ack_window_ms: 300_000, max_repeats: 1 },
        { step: 2, target_role: "backup_contact", ack_window_ms: 300_000, max_repeats: 1 },
        { step: 3, target_role: "emergency_service_sim", ack_window_ms: 0, max_repeats: 0 },
      ],
      thresholds_validated: false,
    },
  });
  const join = (id: string, role: "host" | "member", via: "host_created" | "invite_link" | "qr_code", scopes: ConsentScope[]) => {
    const actor = { kind: role === "host" ? ("host" as const) : ("participant" as const), id };
    timeline.append({ type: "session.participant_joined", participant_id: id, actor, provenance: prov("session_manager"), data: { role, joined_via: via } });
    timeline.append({ type: "consent.granted", participant_id: id, actor, provenance: prov("ui"), data: { scopes, consent_text_version: "consent-v0.1" } });
  };
  join(HOST, "host", "host_created", ["monitoring", "location.group"]);
  tick(at(1));
  join(SAM, "member", "invite_link", ["monitoring", "location.group", "location.responders", "profile.responders"]);
  timeline.append({
    type: "profile.shared",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: prov("ui"),
    data: {
      display_name: "Sam (synthetic)",
      preferred_language: "English",
      emergency_notes: "Synthetic demo note: carries an inhaler in left jacket pocket.",
    },
  });
  tick(at(1, 30));
  // Alex shares nothing with responders; none of Alex's data may reach Sam's briefing.
  join(ALEX, "member", "qr_code", ["monitoring"]);

  // ── 23:02–23:07 Calibration: five windows of Sam's normal movement. ────
  const calibration = [1.0, 1.3, 0.8, 1.5, 1.1].map((amp, i) => motionWindow(at(3 + i), IN_POCKET, amp, 0.25));
  const features = baselineFrom(
    calibration.map((w) => w.data),
    ["dynamic_mean_m_s2", "dynamic_peak_m_s2", "stillness_ratio"],
  );
  const baseline = timeline.append({
    type: "sensor.baseline_calibrated",
    participant_id: SAM,
    actor: { kind: "detector", id: null },
    provenance: prov("detector", { producer: "baseline@0.1.0" }),
    caused_by: calibration.map((w) => w.event_id),
    data: {
      window_start: calibration[0]!.data.window_start,
      window_end: calibration.at(-1)!.data.window_end,
      window_ms: WINDOW_MS,
      sampling_rate_hz: RATE_HZ,
      device_kind: "synthetic",
      features,
    },
  });

  // ── 23:40 Walking across the venue. ────────────────────────────────────
  const fix = (m: number, lat: number, lon: number, speed: number, heading: number | null, label?: string) => {
    tick(at(m));
    return timeline.append({
      type: "location.reported",
      participant_id: SAM,
      actor: { kind: "participant", id: SAM },
      provenance: prov("sensor_adapter"),
      data: {
        latitude: lat,
        longitude: lon,
        accuracy_m: 12,
        fix_at: toIso(at(m)),
        source: "synthetic",
        speed_m_s: speed,
        heading_deg: heading,
        ...(label ? { place_label: label } : {}),
      },
    });
  };
  fix(40, 43.6618, -79.3984, 1.3, 75);

  // ── 23:47–23:52 Active, then still with the phone now lying flat. ──────
  motionWindow(at(47), IN_POCKET, 1.4, 0.25);
  motionWindow(at(48), IN_POCKET, 1.2, 0.25);
  motionWindow(at(49), IN_POCKET, 1.3, 0.25);
  const lastFix = fix(50, 43.6629, -79.3957, 0, null, "Synthetic Venue A, rear patio");
  motionWindow(at(50), IN_POCKET, 0.3, 0.1);
  motionWindow(at(51), FLAT, 0.02, 0.02);
  const stillWindow = motionWindow(at(52), FLAT, 0.0, 0.02);

  // Stand-in detector: z-score of the window's movement against the personal baseline.
  const ref = features.find((f) => f.name === "dynamic_mean_m_s2")!;
  const observed = stillWindow.data.dynamic_mean_m_s2;
  const anomaly = timeline.append({
    type: "sensor.motion_anomaly_observed",
    participant_id: SAM,
    actor: { kind: "detector", id: null },
    provenance: prov("detector", { producer: "zscore-detector@0.1.0" }),
    caused_by: [stillWindow.event_id, baseline.event_id],
    data: {
      feature: "dynamic_mean_m_s2",
      unit: "m/s^2",
      observed_value: observed,
      baseline_mean: ref.mean,
      baseline_std_dev: ref.std_dev,
      z_score: round((observed - ref.mean) / ref.std_dev),
      window_start: stillWindow.data.window_start,
      window_end: stillWindow.data.window_end,
      rule: { id: "stillness-z", comparator: "<=", threshold: -3, threshold_validated: false },
    },
  });
  const checkin = timeline.append({
    type: "checkin.prompted",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("incident_manager"),
    caused_by: [anomaly.event_id],
    data: { checkin_id: "chk_0001", trigger: "motion_anomaly", delivery: "haptic", response_deadline_at: toIso(at(54)) },
  });

  // ── 23:52:40 Sam's phone drops off. Timers keep running server-side. ───
  tick(at(52, 40));
  timeline.append({
    type: "sensor.stream_interrupted",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("sensor_adapter"),
    data: { last_sample_at: toIso(at(52) - 100), reason: "device_disconnected" },
  });
  const offline = timeline.append({
    type: "connectivity.device_offline",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("session_manager"),
    data: { last_seen_at: toIso(at(52, 10)), detected_by: "heartbeat_timeout", heartbeat_interval_ms: 15_000 },
  });

  // ── 23:54 No response: incident opens, host is alerted. ────────────────
  tick(at(54));
  const missed = timeline.append({
    type: "checkin.missed",
    participant_id: SAM,
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    caused_by: [checkin.event_id],
    data: { checkin_id: "chk_0001", response_deadline_at: toIso(at(54)) },
  });
  const opened = timeline.append({
    type: "incident.opened",
    incident_id: FIXTURE_INCIDENT_ID,
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("incident_manager"),
    caused_by: [missed.event_id],
    data: { trigger: "checkin_missed", trigger_event_id: missed.event_id },
  });
  const scope = { incident_id: FIXTURE_INCIDENT_ID, participant_id: SAM };
  // Exactly what each recipient is told; recipients may act only on these.
  const delivered = [anomaly.event_id, missed.event_id, offline.event_id, lastFix.event_id];

  const alert = (id: string, recipient: string, role: "host" | "backup_contact", step: number, attempt: number, cause: TimelineEvent) =>
    timeline.append({
      ...scope,
      type: "notification.sent",
      actor: { kind: "transport_sim", id: null },
      provenance: simulated("transport_sim"),
      caused_by: [cause.event_id],
      data: {
        notification_id: id,
        recipient_id: recipient,
        recipient_role: role,
        channel: role === "host" ? "in_app_sim" : "push_sim",
        escalation_step: step,
        attempt,
        is_repeat: attempt > 1,
        delivered_fact_event_ids: delivered,
      },
    });
  const schedule = (step: number, target: "backup_contact" | "emergency_service_sim", dueMs: number, basis: TimelineEvent) =>
    timeline.append({
      ...scope,
      type: "escalation.step_scheduled",
      actor: { kind: "scheduler", id: null },
      provenance: prov("escalation_scheduler"),
      caused_by: [basis.event_id],
      data: { escalation_id: "esc_0001", step, target_role: target, due_at: toIso(dueMs), deadline_basis_event_id: basis.event_id },
    });
  const fire = (step: number, target: "backup_contact" | "emergency_service_sim", dueMs: number) => {
    tick(dueMs);
    return timeline.append({
      ...scope,
      type: "escalation.step_fired",
      actor: { kind: "scheduler", id: null },
      provenance: prov("escalation_scheduler"),
      data: { escalation_id: "esc_0001", step, target_role: target, scheduled_due_at: toIso(dueMs), fired_late_ms: 0 },
    });
  };

  const toHost = alert("ntf_0001", HOST, "host", 1, 1, opened);
  schedule(2, "backup_contact", at(59), toHost);
  tick(at(54, 1));
  timeline.append({
    ...scope,
    type: "notification.delivered",
    actor: { kind: "transport_sim", id: null },
    provenance: simulated("transport_sim"),
    data: { notification_id: "ntf_0001", recipient_id: HOST },
  });
  tick(at(55, 30));
  timeline.append({
    ...scope,
    type: "notification.viewed",
    actor: { kind: "host", id: HOST },
    provenance: simulated("transport_sim"),
    data: { notification_id: "ntf_0001", recipient_id: HOST },
  });
  // 23:56 Repeat to the host. The step-2 deadline stays anchored to the first alert.
  tick(at(56));
  alert("ntf_0001", HOST, "host", 1, 2, toHost);

  // ── 23:59 Host never acknowledged: backup contact. ─────────────────────
  const step2 = fire(2, "backup_contact", at(59));
  const toBackup = alert("ntf_0002", BACKUP, "backup_contact", 2, 1, step2);
  schedule(3, "emergency_service_sim", at(64), toBackup);
  tick(at(59, 2));
  timeline.append({
    ...scope,
    type: "notification.delivery_failed",
    actor: { kind: "transport_sim", id: null },
    provenance: simulated("transport_sim"),
    data: { notification_id: "ntf_0002", recipient_id: BACKUP, reason: "recipient_offline", will_retry: true },
  });

  // ── 00:04 Still unacknowledged: simulated emergency services. ──────────
  const step3 = fire(3, "emergency_service_sim", at(64));
  timeline.append({
    ...scope,
    type: "emergency.simulated_dispatch_requested",
    actor: { kind: "system", id: null },
    provenance: simulated("transport_sim"),
    caused_by: [step3.event_id],
    data: { mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID, escalation_id: "esc_0001", delivered_fact_event_ids: delivered },
  });
  tick(at(64, 3));
  const call = timeline.append({
    ...scope,
    type: "voice.call_started",
    actor: { kind: "voice_agent", id: null },
    provenance: simulated("voice_agent"),
    caused_by: [step3.event_id],
    data: { call_id: "call_0001", mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID },
  });
  const say = (turn: number, speaker: "voice_agent" | "mock_operator", text: string, grounding: string[]) =>
    timeline.append({
      ...scope,
      type: "voice.utterance",
      actor: { kind: speaker, id: null },
      provenance: simulated("voice_agent"),
      data: { call_id: "call_0001", turn_index: turn, speaker, text, grounding_event_ids: grounding, interrupted: false },
    });
  say(0, "voice_agent", "This is an automated assistant from the YPC safety system. This is a simulated call.", [call.event_id]);
  tick(at(64, 8));
  say(1, "mock_operator", "Go ahead. What is the situation?", []);

  return { clock, timeline, rawLines, ids: { baseline, stillWindow, anomaly, checkin, offline, opened, lastFix, toHost, toBackup, call } };
}

/** Writes the example files: timeline, briefing and the raw recording behind the motion windows. */
export function writeExamples(dir: string): void {
  const { timeline, rawLines, clock } = buildNoResponseScenario();
  const briefing = buildOperatorBriefing(timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: clock.now() });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "no-response-incident.jsonl"), toJsonl(timeline.events));
  writeFileSync(join(dir, "no-response-briefing.json"), `${JSON.stringify(briefing, null, 2)}\n`);
  writeFileSync(join(dir, "synthetic-raw-accelerometer.jsonl"), rawLines.map((l) => `${l}\n`).join(""));
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  writeExamples(argv[2] ?? "docs/examples");
}
