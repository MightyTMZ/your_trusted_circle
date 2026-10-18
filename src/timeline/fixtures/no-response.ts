/**
 * Synthetic four-hour night out covering KAZE scenarios 1 (safe), 2 (no
 * response), 4 (connectivity failure) and 5 (unacknowledged alert). All
 * identities, places and readings are invented.
 *
 * The fixture supplies only *inputs*: accelerometer samples minute by
 * minute and the humans' actions (consent, check-in answers, alerts). Every
 * motion window, the baseline, anomalies and patterns are produced by the
 * real SensorPipeline and detectors; if they do not fire, this throws.
 *
 *   20:00  arrive walking (calibration)       21:22  dancing until 22:40
 *   20:10  sitting                             22:40  standing, chatting
 *   21:00  phone left on a table -> check-in   23:30  walking to the patio
 *          answered OK (false alarm)           23:50:58 hard impact, then still
 *   21:15  app backgrounded for 7 min          23:52:40 phone drops off
 *                                              23:54  no answer -> escalation
 *
 * `npm run examples` regenerates docs/examples/ (timeline + briefing) and
 * data/examples/ (raw recording, git-ignored: ~10 MB).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { ManualClock, toIso } from "../../shared/clock.js";
import { SequentialIds } from "../../shared/ids.js";
import { SensorPipeline } from "../../sensors/pipeline.js";
import { ORIENTATION, addImpact, seeded, synthesize, type Motion, type Vec3 } from "../../sensors/synthetic.js";
import type { Sample } from "../../sensors/stream.js";
import { MOCK_OPERATOR_ENDPOINT_ID, type ConsentScope, type Provenance } from "../schema/envelope.js";
import type { EventType, TimelineEvent } from "../schema/catalog.js";
import { Timeline } from "../timeline.js";
import { toJsonl } from "../jsonl.js";
import { buildOperatorBriefing } from "../briefing.js";

export const FIXTURE_SESSION_ID = "ses_0001";
export const FIXTURE_INCIDENT_ID = "inc_0001";
export const FIXTURE_START_MS = Date.UTC(2026, 9, 17, 20, 0, 0, 0);

const HOST = "par_0001";
const SAM = "par_0002";
const ALEX = "par_0003";
const BACKUP = "con_0001";
const SCENARIO = "night-out-v3";
const RATE_HZ = 25;
const MINUTE = 60_000;
const SENSOR_RANGE = 156.9064;

const at = (m: number, s = 0) => FIXTURE_START_MS + m * MINUTE + s * 1000;
const prov = (component: Provenance["component"], simulated = false): Provenance => ({
  component,
  data_origin: "synthetic_scenario",
  simulated,
  scenario_id: SCENARIO,
});

/** What Sam's phone experiences during minute m (from 20:00). null = no samples. */
function plan(m: number): { motion: Motion; gravity: Vec3; durationMs?: number } | null {
  const pocket = ORIENTATION.inPocket;
  if (m < 10) return { motion: { kind: "rhythmic", hz: 1.8, amplitude: 2 }, gravity: pocket };
  if (m < 60) return { motion: { kind: "fidget", amplitude: 0.4 }, gravity: pocket };
  if (m < 75) return { motion: { kind: "still" }, gravity: ORIENTATION.flat };
  if (m < 82) return null; // app backgrounded
  if (m < 160) return { motion: { kind: "rhythmic", hz: 2.3, amplitude: 4, jitter: 0.05 }, gravity: pocket };
  if (m < 210) return { motion: { kind: "fidget", amplitude: 0.6 }, gravity: pocket };
  if (m < 231) return { motion: { kind: "rhythmic", hz: 1.8, amplitude: 2 }, gravity: pocket };
  if (m === 231) return { motion: { kind: "still" }, gravity: ORIENTATION.flat };
  if (m === 232) return { motion: { kind: "still" }, gravity: ORIENTATION.flat, durationMs: 40_000 };
  return null; // phone offline
}

function minuteOfSamples(m: number, rand: () => number): Sample[] {
  const p = plan(m);
  if (!p) return [];
  const start = at(m) + 5;
  const samples = synthesize({ start, durationMs: (p.durationMs ?? MINUTE) - 10, rateHz: RATE_HZ, gravity: p.gravity, motion: p.motion, rand, timingJitterMs: 1.5 });
  if (m === 230) {
    // Walking, then a hard impact at 23:50:58 that saturates the sensor, then the phone lies flat.
    const flatFrom = at(230, 58.2);
    for (const s of samples) {
      if (s.t < flatFrom) continue;
      s.x = ORIENTATION.flat[0] + (rand() - 0.5) * 0.02;
      s.y = ORIENTATION.flat[1] + (rand() - 0.5) * 0.02;
      s.z = ORIENTATION.flat[2] + (rand() - 0.5) * 0.02;
    }
    addImpact(samples, at(230, 58), 190, ORIENTATION.inPocket);
    for (const s of samples) {
      s.x = clamp(s.x);
      s.y = clamp(s.y);
      s.z = clamp(s.z);
    }
  }
  return samples;
}

const clamp = (v: number) => Math.max(-SENSOR_RANGE, Math.min(SENSOR_RANGE, v));

/** voiceCall: false stops at the simulated dispatch, before the call, so a live agent can place it. */
export function buildNoResponseScenario(opts: { voiceCall?: boolean } = {}) {
  const clock = new ManualClock(FIXTURE_START_MS);
  const timeline = new Timeline({ sessionId: FIXTURE_SESSION_ID, clock, ids: new SequentialIds() });
  const rawLines: string[] = [];
  const rand = seeded(17);
  const detected: TimelineEvent[] = [];
  const pipeline = new SensorPipeline({
    timeline,
    clock,
    participantId: SAM,
    recordingId: "rec_0001",
    source: { sensor: "accelerometer", deviceKind: "synthetic", deviceModel: null, sensorName: "synthetic accelerometer", dataOrigin: "synthetic_scenario", scenarioId: SCENARIO },
    rawWrite: (line) => rawLines.push(line),
    features: { nominalRateHz: RATE_HZ, sensorRangeM_s2: SENSOR_RANGE },
  });

  /** Runs the sensor pipeline minute by minute up to time t, the way the server would. */
  let cursor = FIXTURE_START_MS;
  const advanceTo = (t: number) => {
    while (cursor + MINUTE + 2_000 <= t) {
      const samples = minuteOfSamples((cursor - FIXTURE_START_MS) / MINUTE, rand);
      clock.set(cursor + MINUTE + 2_000);
      detected.push(...pipeline.ingest(samples), ...pipeline.tick());
      cursor += MINUTE;
    }
    if (t > clock.now()) clock.set(t);
  };
  const detection = <T extends EventType>(type: T, windowEnd: number, pattern?: string) => {
    const found = detected.find(
      (e): e is TimelineEvent<T> =>
        e.type === type &&
        Date.parse(e.occurred_at) === windowEnd &&
        (!pattern || (e.type === "sensor.motion_pattern_observed" && e.data.pattern === pattern)),
    );
    if (!found) throw new Error(`Scenario expected the detector to report ${type}${pattern ? `/${pattern}` : ""} at ${toIso(windowEnd)}`);
    return found;
  };

  // ── 20:00 Session setup. Each person opts in for themselves. ───────────
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
        { step: 2, target_role: "participant", ack_window_ms: 300_000, max_repeats: 1 },
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
  join(SAM, "member", "invite_link", ["monitoring", "location.group", "location.responders", "profile.responders"]);
  timeline.append({
    type: "profile.shared",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: prov("ui"),
    data: { display_name: "Sam (synthetic)", preferred_language: "English", emergency_notes: "Synthetic demo note: carries an inhaler in left jacket pocket." },
  });
  join(ALEX, "member", "qr_code", ["monitoring"]); // Alex shares nothing with responders.
  pipeline.start();

  const fix = (m: number, s: number, lat: number, lon: number, speed: number, heading: number | null, label?: string) => {
    advanceTo(at(m, s));
    return timeline.append({
      type: "location.reported",
      participant_id: SAM,
      actor: { kind: "participant", id: SAM },
      provenance: prov("sensor_adapter"),
      data: { latitude: lat, longitude: lon, accuracy_m: 12, fix_at: toIso(at(m, s)), source: "synthetic", speed_m_s: speed, heading_deg: heading, ...(label ? { place_label: label } : {}) },
    });
  };
  fix(0, 30, 43.6611, -79.4003, 1.4, 120, "Synthetic Venue A, entrance");
  fix(30, 0, 43.6622, -79.3971, 0, null, "Synthetic Venue A, main room");

  // ── 21:01 Phone left on a table: a private check-in, answered OK. ──────
  advanceTo(at(61, 2));
  const tableAnomaly = detection("sensor.motion_anomaly_observed", at(61));
  const tableCheckin = timeline.append({
    type: "checkin.prompted",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("incident_manager"),
    caused_by: [tableAnomaly.event_id],
    data: { checkin_id: "chk_0001", trigger: "motion_anomaly", delivery: "haptic", response_deadline_at: toIso(at(63, 2)) },
  });
  advanceTo(at(61, 20));
  timeline.append({
    type: "checkin.responded",
    participant_id: SAM,
    actor: { kind: "participant", id: SAM },
    provenance: prov("ui"),
    caused_by: [tableCheckin.event_id],
    data: { checkin_id: "chk_0001", response: "confirmed_ok", method: "tap", latency_ms: 18_000 },
  });

  fix(90, 0, 43.6623, -79.3969, 0.2, null, "Synthetic Venue A, dance floor");
  fix(180, 0, 43.6621, -79.3972, 0, null, "Synthetic Venue A, bar");

  // ── 23:30 Walking out to the patio. ─────────────────────────────────────
  fix(215, 0, 43.6619, -79.3978, 1.3, 80);
  fix(225, 0, 43.6626, -79.3962, 1.2, 95);
  const lastFix = fix(230, 30, 43.6629, -79.3957, 0.9, 100, "Synthetic Venue A, rear patio");

  // ── 23:52 Impact, then stillness: the detectors raise it; a check-in goes out. ─
  advanceTo(at(232, 2));
  const impactPattern = detection("sensor.motion_pattern_observed", at(232), "impact_then_stillness");
  const anomaly = detection("sensor.motion_anomaly_observed", at(232));
  const checkin = timeline.append({
    type: "checkin.prompted",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("incident_manager"),
    caused_by: [impactPattern.event_id, anomaly.event_id],
    data: { checkin_id: "chk_0002", trigger: "motion_pattern", delivery: "haptic", response_deadline_at: toIso(at(234, 2)) },
  });

  // ── 23:52:55 The phone stops reaching the server. Timers keep running. ─
  advanceTo(at(232, 55));
  const offline = timeline.append({
    type: "connectivity.device_offline",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("session_manager"),
    data: { last_seen_at: toIso(at(232, 40)), detected_by: "heartbeat_timeout", heartbeat_interval_ms: 15_000 },
  });

  // ── 23:54:02 No answer: incident opens, host is alerted. ───────────────
  advanceTo(at(234, 2));
  const missed = timeline.append({
    type: "checkin.missed",
    participant_id: SAM,
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    caused_by: [checkin.event_id],
    data: { checkin_id: "chk_0002", response_deadline_at: toIso(at(234, 2)) },
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
  const delivered = [impactPattern.event_id, anomaly.event_id, missed.event_id, offline.event_id, lastFix.event_id];

  const alert = (id: string, recipient: string, role: "host" | "participant" | "backup_contact", step: number, attempt: number, cause: TimelineEvent) =>
    timeline.append({
      ...scope,
      type: "notification.sent",
      actor: { kind: "transport_sim", id: null },
      provenance: prov("transport_sim", true),
      caused_by: [cause.event_id],
      data: { notification_id: id, recipient_id: recipient, recipient_role: role, channel: role === "host" || role === "participant" ? "in_app_sim" : "push_sim", escalation_step: step, attempt, is_repeat: attempt > 1, delivered_fact_event_ids: delivered },
    });
  const schedule = (step: number, target: "participant" | "emergency_service_sim", dueMs: number, basis: TimelineEvent) =>
    timeline.append({
      ...scope,
      type: "escalation.step_scheduled",
      actor: { kind: "scheduler", id: null },
      provenance: prov("escalation_scheduler"),
      caused_by: [basis.event_id],
      data: { escalation_id: "esc_0001", step, target_role: target, due_at: toIso(dueMs), deadline_basis_event_id: basis.event_id },
    });
  const fire = (step: number, target: "participant" | "emergency_service_sim", dueMs: number) => {
    advanceTo(dueMs);
    return timeline.append({
      ...scope,
      type: "escalation.step_fired",
      actor: { kind: "scheduler", id: null },
      provenance: prov("escalation_scheduler"),
      data: { escalation_id: "esc_0001", step, target_role: target, scheduled_due_at: toIso(dueMs), fired_late_ms: 0 },
    });
  };
  const transport = (type: "notification.delivered" | "notification.viewed", id: string, recipient: string, t: number) => {
    advanceTo(t);
    timeline.append({ ...scope, type, actor: { kind: type === "notification.viewed" ? "host" : "transport_sim", id: type === "notification.viewed" ? recipient : null }, provenance: prov("transport_sim", true), data: { notification_id: id, recipient_id: recipient } });
  };

  const toHost = alert("ntf_0001", HOST, "host", 1, 1, opened);
  schedule(2, "participant", at(239, 2), toHost);
  transport("notification.delivered", "ntf_0001", HOST, at(234, 3));
  transport("notification.viewed", "ntf_0001", HOST, at(235, 30));
  advanceTo(at(236, 2));
  alert("ntf_0001", HOST, "host", 1, 2, toHost); // repeat; the step-2 deadline does not move

  // ── 23:59:02 host never acknowledged: group and backup contacts. ───────
  const step2 = fire(2, "participant", at(239, 2));
  alert("ntf_0003", ALEX, "participant", 2, 1, step2);
  const toBackup = alert("ntf_0002", BACKUP, "backup_contact", 2, 1, step2);
  schedule(3, "emergency_service_sim", at(244, 2), toBackup);
  advanceTo(at(239, 4));
  timeline.append({
    ...scope,
    type: "notification.delivery_failed",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    data: { notification_id: "ntf_0002", recipient_id: BACKUP, reason: "recipient_offline", will_retry: true },
  });

  // ── 00:04:02 Still unacknowledged: simulated emergency services. ───────
  const step3 = fire(3, "emergency_service_sim", at(244, 2));
  timeline.append({
    ...scope,
    type: "emergency.simulated_dispatch_requested",
    actor: { kind: "system", id: null },
    provenance: prov("transport_sim", true),
    caused_by: [step3.event_id],
    data: { mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID, escalation_id: "esc_0001", delivered_fact_event_ids: delivered },
  });
  // ── 00:04:05 The example call (left out for a live agent). ─────────────
  let call: TimelineEvent<"voice.call_started"> | undefined;
  if (opts.voiceCall !== false) {
    advanceTo(at(244, 5));
    call = timeline.append({
      ...scope,
      type: "voice.call_started",
      actor: { kind: "voice_agent", id: null },
      provenance: prov("voice_agent", true),
      caused_by: [step3.event_id],
      data: { call_id: "call_0001", mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID },
    });
    const say = (turn: number, speaker: "voice_agent" | "mock_operator", text: string, grounding: string[]) =>
      timeline.append({
        ...scope,
        type: "voice.utterance",
        actor: { kind: speaker, id: null },
        provenance: prov("voice_agent", true),
        data: { call_id: "call_0001", turn_index: turn, speaker, text, grounding_event_ids: grounding, interrupted: false },
      });
    say(0, "voice_agent", "This is an automated assistant from the YTC safety system. This is a simulated call.", [call.event_id]);
    advanceTo(at(244, 10));
    say(1, "mock_operator", "Go ahead. What is the situation?", []);
  }

  const pick = <T extends EventType>(type: T) => timeline.events.filter((e): e is TimelineEvent<T> => e.type === type);
  return {
    clock,
    timeline,
    rawLines,
    pipeline,
    ids: { tableAnomaly, tableCheckin, impactPattern, anomaly, checkin, offline, opened, lastFix, toHost, toBackup, call, baseline: pick("sensor.baseline_calibrated")[0]! },
  };
}

/** Writes the committed examples (timeline, briefing) and the git-ignored raw recording. */
export function writeExamples(docsDir: string, rawDir: string): void {
  const { timeline, rawLines, clock } = buildNoResponseScenario();
  const briefing = buildOperatorBriefing(timeline.events, { incidentId: FIXTURE_INCIDENT_ID, now: clock.now() });
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(docsDir, "no-response-incident.jsonl"), toJsonl(timeline.events));
  writeFileSync(join(docsDir, "no-response-briefing.json"), `${JSON.stringify(briefing, null, 2)}\n`);
  writeFileSync(join(rawDir, "synthetic-raw-accelerometer.jsonl"), rawLines.map((l) => `${l}\n`).join(""));
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  writeExamples(argv[2] ?? "docs/examples", argv[3] ?? "data/examples");
}
