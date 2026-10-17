/**
 * Synthetic timeline for the KAZE "No response" + "Unacknowledged alert"
 * scenarios. All identities, locations and readings are invented.
 *
 * This is a hand-authored log fixture for the timeline format and the
 * briefing, not a detector run: the anomaly event below is written
 * directly rather than produced by the detector from inputs.
 *
 * Run `npm run example:timeline` to regenerate docs/examples/.
 */
import { argv, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { ManualClock, toIso } from "../../shared/clock.js";
import { SequentialIds } from "../../shared/ids.js";
import { MOCK_OPERATOR_ENDPOINT_ID, type Provenance } from "../schema/envelope.js";
import { Timeline } from "../timeline.js";
import { toJsonl } from "../jsonl.js";

export const FIXTURE_SESSION_ID = "ses_0001";
export const FIXTURE_INCIDENT_ID = "inc_0001";
export const FIXTURE_START_MS = Date.UTC(2026, 9, 17, 23, 0, 0, 0);

const HOST = "par_0001";
const SAM = "par_0002";
const ALEX = "par_0003";
const BACKUP = "con_0001";
const SCENARIO = "no-response-v1";

const prov = (component: Provenance["component"], simulated = false): Provenance => ({
  component,
  data_origin: "synthetic_scenario",
  simulated,
  scenario_id: SCENARIO,
});

const min = (m: number, s = 0) => FIXTURE_START_MS + m * 60_000 + s * 1000;

export function buildNoResponseTimeline() {
  const clock = new ManualClock(FIXTURE_START_MS);
  const timeline = new Timeline({ sessionId: FIXTURE_SESSION_ID, clock, ids: new SequentialIds() });
  const at = (ms: number) => clock.set(ms);

  // 23:00 Host sets up the session; everyone opts in for themselves.
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
  const join = (id: string, role: "host" | "member", via: "host_created" | "invite_link" | "qr_code") =>
    timeline.append({
      type: "session.participant_joined",
      participant_id: id,
      actor: { kind: role === "host" ? "host" : "participant", id },
      provenance: prov("session_manager"),
      data: { role, joined_via: via },
    });
  const consent = (id: string, scopes: ("monitoring" | "location.group" | "location.responders" | "profile.responders")[]) =>
    timeline.append({
      type: "consent.granted",
      participant_id: id,
      actor: { kind: id === HOST ? "host" : "participant", id },
      provenance: prov("ui"),
      data: { scopes, consent_text_version: "consent-v0.1" },
    });

  join(HOST, "host", "host_created");
  consent(HOST, ["monitoring", "location.group"]);
  at(min(2));
  join(SAM, "member", "invite_link");
  consent(SAM, ["monitoring", "location.group", "location.responders", "profile.responders"]);
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
  at(min(3));
  join(ALEX, "member", "qr_code");
  consent(ALEX, ["monitoring"]);

  // 23:12 Personal baseline from the first ten minutes.
  at(min(12));
  timeline.append({
    type: "sensor.baseline_calibrated",
    participant_id: SAM,
    actor: { kind: "detector", id: null },
    provenance: { ...prov("detector"), producer: "zscore-baseline@0.1.0" },
    data: {
      window_start: toIso(min(2)),
      window_end: toIso(min(12)),
      sampling_rate_hz: 50,
      device_kind: "synthetic",
      features: [{ name: "movement_rms_60s", unit: "m/s^2", mean: 1.1, std_dev: 0.35, sample_count: 30_000 }],
    },
  });

  // 23:40 Last location fix before the device drops.
  at(min(40));
  const fix = timeline.append({
    type: "location.reported",
    participant_id: SAM,
    occurred_at: min(40),
    actor: { kind: "participant", id: SAM },
    provenance: prov("sensor_adapter"),
    data: {
      latitude: 43.6629,
      longitude: -79.3957,
      accuracy_m: 15,
      fix_at: toIso(min(40)),
      source: "synthetic",
      place_label: "Synthetic Venue A, rear patio",
    },
  });

  // 23:52 Sustained stillness relative to Sam's baseline -> private check-in.
  at(min(52));
  const anomaly = timeline.append({
    type: "sensor.motion_anomaly_observed",
    participant_id: SAM,
    actor: { kind: "detector", id: null },
    provenance: { ...prov("detector"), producer: "zscore-detector@0.1.0" },
    data: {
      feature: "movement_rms_60s",
      unit: "m/s^2",
      observed_value: 0.04,
      baseline_mean: 1.1,
      baseline_std_dev: 0.35,
      z_score: -3.029,
      window_start: toIso(min(51)),
      window_end: toIso(min(52)),
      rule: { id: "stillness-z", comparator: "<=", threshold: -3, threshold_validated: false },
    },
  });
  const checkin = timeline.append({
    type: "checkin.prompted",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("incident_manager"),
    caused_by: [anomaly.event_id],
    data: { checkin_id: "chk_0001", trigger: "motion_anomaly", delivery: "haptic", response_deadline_at: toIso(min(54)) },
  });

  // 23:52:40 Sam's phone stops reaching the server. Timers keep running.
  at(min(52, 40));
  const offline = timeline.append({
    type: "connectivity.device_offline",
    participant_id: SAM,
    actor: { kind: "system", id: null },
    provenance: prov("session_manager"),
    data: { last_seen_at: toIso(min(52, 10)), detected_by: "heartbeat_timeout", heartbeat_interval_ms: 15_000 },
  });

  // 23:54 No response -> incident, host alerted.
  at(min(54));
  const missed = timeline.append({
    type: "checkin.missed",
    participant_id: SAM,
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    caused_by: [checkin.event_id],
    data: { checkin_id: "chk_0001", response_deadline_at: toIso(min(54)) },
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
  const incidentEvent = { incident_id: FIXTURE_INCIDENT_ID, participant_id: SAM };
  const facts = [anomaly.event_id, missed.event_id, offline.event_id, fix.event_id];

  const toHost = timeline.append({
    ...incidentEvent,
    type: "notification.sent",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    caused_by: [opened.event_id],
    data: {
      notification_id: "ntf_0001",
      recipient_id: HOST,
      recipient_role: "host",
      channel: "in_app_sim",
      escalation_step: 1,
      attempt: 1,
      is_repeat: false,
      delivered_fact_event_ids: facts,
    },
  });
  timeline.append({
    ...incidentEvent,
    type: "escalation.step_scheduled",
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    caused_by: [toHost.event_id],
    data: {
      escalation_id: "esc_0001",
      step: 2,
      target_role: "backup_contact",
      due_at: toIso(min(59)),
      deadline_basis_event_id: toHost.event_id,
    },
  });
  at(min(54, 1));
  timeline.append({
    ...incidentEvent,
    type: "notification.delivered",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    data: { notification_id: "ntf_0001", recipient_id: HOST },
  });

  // 23:56 Repeat to host; the step-2 deadline does not move.
  at(min(56));
  timeline.append({
    ...incidentEvent,
    type: "notification.sent",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    caused_by: [toHost.event_id],
    data: {
      notification_id: "ntf_0001",
      recipient_id: HOST,
      recipient_role: "host",
      channel: "in_app_sim",
      escalation_step: 1,
      attempt: 2,
      is_repeat: true,
      delivered_fact_event_ids: facts,
    },
  });

  // 23:59 Host never acknowledged -> backup contact.
  at(min(59));
  const step2 = timeline.append({
    ...incidentEvent,
    type: "escalation.step_fired",
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    data: { escalation_id: "esc_0001", step: 2, target_role: "backup_contact", scheduled_due_at: toIso(min(59)), fired_late_ms: 0 },
  });
  const toBackup = timeline.append({
    ...incidentEvent,
    type: "notification.sent",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    caused_by: [step2.event_id],
    data: {
      notification_id: "ntf_0002",
      recipient_id: BACKUP,
      recipient_role: "backup_contact",
      channel: "push_sim",
      escalation_step: 2,
      attempt: 1,
      is_repeat: false,
      delivered_fact_event_ids: facts,
    },
  });
  timeline.append({
    ...incidentEvent,
    type: "escalation.step_scheduled",
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    caused_by: [toBackup.event_id],
    data: {
      escalation_id: "esc_0001",
      step: 3,
      target_role: "emergency_service_sim",
      due_at: toIso(min(64)),
      deadline_basis_event_id: toBackup.event_id,
    },
  });
  at(min(59, 2));
  timeline.append({
    ...incidentEvent,
    type: "notification.delivery_failed",
    actor: { kind: "transport_sim", id: null },
    provenance: prov("transport_sim", true),
    data: { notification_id: "ntf_0002", recipient_id: BACKUP, reason: "recipient_offline", will_retry: true },
  });

  // 00:04 Still unacknowledged -> simulated emergency services via mock operator.
  at(min(64));
  const step3 = timeline.append({
    ...incidentEvent,
    type: "escalation.step_fired",
    actor: { kind: "scheduler", id: null },
    provenance: prov("escalation_scheduler"),
    data: {
      escalation_id: "esc_0001",
      step: 3,
      target_role: "emergency_service_sim",
      scheduled_due_at: toIso(min(64)),
      fired_late_ms: 0,
    },
  });
  timeline.append({
    ...incidentEvent,
    type: "emergency.simulated_dispatch_requested",
    actor: { kind: "system", id: null },
    provenance: prov("transport_sim", true),
    caused_by: [step3.event_id],
    data: { mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID, escalation_id: "esc_0001", delivered_fact_event_ids: facts },
  });
  at(min(64, 3));
  const call = timeline.append({
    ...incidentEvent,
    type: "voice.call_started",
    actor: { kind: "voice_agent", id: null },
    provenance: prov("voice_agent", true),
    caused_by: [step3.event_id],
    data: { call_id: "call_0001", mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID },
  });
  const say = (turn: number, speaker: "voice_agent" | "mock_operator", text: string, grounding: string[]) =>
    timeline.append({
      ...incidentEvent,
      type: "voice.utterance",
      actor: { kind: speaker, id: null },
      provenance: prov("voice_agent", true),
      data: { call_id: "call_0001", turn_index: turn, speaker, text, grounding_event_ids: grounding, interrupted: false },
    });
  say(0, "voice_agent", "This is an automated assistant from the YPC safety system. This is a simulated call.", [call.event_id]);
  at(min(64, 8));
  say(1, "mock_operator", "Go ahead. What is the situation?", []);

  return { clock, timeline, ids: { anomaly, checkin, offline, missed, opened, fix, toHost, toBackup, call } };
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  stdout.write(toJsonl(buildNoResponseTimeline().timeline.events));
}
