/**
 * Catalog of every timeline event type. Each entry declares its payload
 * schema, scoping rules, sensitivity, and a deterministic summary template.
 *
 * Summaries are rendered from the payload only, never written by hand, so
 * the text the voice agent reads cannot contain anything the data does not.
 *
 * Adding an event type: add one entry here; the timeline, JSONL reader and
 * briefing pick it up automatically. Payload changes that remove or rename
 * fields require a SCHEMA_VERSION bump.
 */
import { v, validate, type Infer, type Issue, type Schema } from "./validate.js";
import {
  CONSENT_SCOPES,
  MOCK_OPERATOR_ENDPOINT_ID,
  SCHEMA_VERSION,
  actorSchema,
  provenanceSchema,
  type Actor,
  type ConsentScope,
  type Provenance,
  type Sensitivity,
} from "./envelope.js";

export type Scope = "required" | "optional";

export interface SummaryContext {
  participant_id: string | null;
  incident_id: string | null;
}

export interface EventSpec<P> {
  description: string;
  payload: Schema<P>;
  /** Consent needed before the payload may be disclosed to responders. */
  sensitivity: Sensitivity;
  incident: Scope;
  participant: Scope;
  /** Emergency and voice events must always be flagged simulated. */
  mustBeSimulated?: boolean;
  /** Only the participant themselves may emit this (e.g. consent: the host cannot consent for others). */
  selfActorOnly?: boolean;
  /** The participant must currently hold at least one of these scopes, or the event is refused. */
  requiresConsent?: readonly ConsentScope[];
  /** Cross-field rules the schema cannot express. */
  refine?: (data: P) => Issue[];
  summarize: (data: P, ctx: SummaryContext) => string;
}

function defineEvent<S extends Schema<any>>(
  spec: Omit<EventSpec<Infer<S>>, "payload"> & { payload: S },
): EventSpec<Infer<S>> {
  return spec;
}

const evtId = () => v.id("evt");
const parId = () => v.id("par");
const shortText = (max = 80) => v.string({ minLength: 1, maxLength: max });
const ms = () => v.number({ min: 0, integer: true });

const RECIPIENT_ROLES = ["host", "backup_contact", "emergency_service_sim"] as const;
const RESPONDER_ROLES = ["host", "backup_contact"] as const;

/** Formats a number for summaries without float noise (max 3 decimals). */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function duration(msValue: number): string {
  if (msValue < 1000) return `${msValue} ms`;
  const s = msValue / 1000;
  return s < 120 ? `${num(s)} s` : `${num(s / 60)} min`;
}

function who(ctx: SummaryContext): string {
  return ctx.participant_id ? `participant ${ctx.participant_id}` : "the session";
}

export const EVENT_CATALOG = {
  // ── Session lifecycle ────────────────────────────────────────────────
  "session.created": defineEvent({
    description: "Host created a buddy session and its escalation policy.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      expires_at: v.timestamp(),
      checkin_response_window_ms: ms(),
      escalation_steps: v.array(
        v.object({
          step: v.number({ min: 1, integer: true }),
          target_role: v.enum(RECIPIENT_ROLES),
          ack_window_ms: ms(),
          max_repeats: v.number({ min: 0, integer: true }),
        }),
        { minLength: 1 },
      ),
      thresholds_validated: v.literal(false),
    }),
    summarize: (d, ctx) =>
      `Session created by host ${ctx.participant_id}; expires ${d.expires_at}. ` +
      `Check-in response window ${duration(d.checkin_response_window_ms)}. Escalation path: ` +
      d.escalation_steps
        .map(
          (s, i) =>
            `step ${s.step} ${s.target_role}` +
            (i === d.escalation_steps.length - 1
              ? " (final step)"
              : ` (escalates if unacknowledged for ${duration(s.ack_window_ms)})`),
        )
        .join(", then ") +
      ". Intervals and thresholds are unvalidated prototype settings.",
  }),

  "session.participant_joined": defineEvent({
    description: "A participant joined the session.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      role: v.enum(["host", "member"] as const),
      joined_via: v.enum(["host_created", "invite_link", "qr_code"] as const),
    }),
    summarize: (d, ctx) => `${cap(who(ctx))} joined as ${d.role} via ${d.joined_via}.`,
  }),

  "session.participant_left": defineEvent({
    description: "A participant left the session; their monitoring and sharing stop.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      reason: v.enum(["voluntary", "session_ended", "session_expired"] as const),
    }),
    summarize: (d, ctx) => `${cap(who(ctx))} left the session (${d.reason}).`,
  }),

  "session.expired": defineEvent({
    description: "Session reached its automatic expiry.",
    sensitivity: "none",
    incident: "optional",
    participant: "optional",
    payload: v.object({ expires_at: v.timestamp() }),
    summarize: (d) => `Session expired automatically at ${d.expires_at}.`,
  }),

  "session.ended": defineEvent({
    description: "Session ended before expiry.",
    sensitivity: "none",
    incident: "optional",
    participant: "optional",
    payload: v.object({
      reason: v.enum(["host_ended", "all_participants_left"] as const),
    }),
    summarize: (d) => `Session ended (${d.reason}).`,
  }),

  // ── Consent and user-contributed data ────────────────────────────────
  "consent.granted": defineEvent({
    description: "Participant granted consent scopes for themselves.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    selfActorOnly: true,
    payload: v.object({
      scopes: v.array(v.enum(CONSENT_SCOPES), { minLength: 1 }),
      consent_text_version: shortText(),
    }),
    summarize: (d, ctx) =>
      `${cap(who(ctx))} granted consent: ${d.scopes.join(", ")} (consent text ${d.consent_text_version}).`,
  }),

  "consent.revoked": defineEvent({
    description: "Participant revoked consent scopes; later disclosures under them stop.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    selfActorOnly: true,
    payload: v.object({
      scopes: v.array(v.enum(CONSENT_SCOPES), { minLength: 1 }),
    }),
    summarize: (d, ctx) => `${cap(who(ctx))} revoked consent: ${d.scopes.join(", ")}.`,
  }),

  "profile.shared": defineEvent({
    description: "Participant-provided profile fields. Disclosed to responders only under profile.responders.",
    sensitivity: "profile",
    incident: "optional",
    participant: "required",
    selfActorOnly: true,
    payload: v.object({
      display_name: v.optional(shortText(64)),
      pronouns: v.optional(shortText(32)),
      preferred_language: v.optional(shortText(32)),
      emergency_notes: v.optional(v.string({ minLength: 1, maxLength: 500 })),
    }),
    refine: (d) =>
      Object.keys(d).length === 0 ? [{ path: "data", message: "must include at least one profile field" }] : [],
    summarize: (d, ctx) => {
      const parts: string[] = [];
      if (d.display_name) parts.push(`name "${d.display_name}"`);
      if (d.pronouns) parts.push(`pronouns "${d.pronouns}"`);
      if (d.preferred_language) parts.push(`preferred language "${d.preferred_language}"`);
      if (d.emergency_notes) parts.push(`emergency notes "${d.emergency_notes}"`);
      return `${cap(who(ctx))} provided (self-reported): ${parts.join("; ")}.`;
    },
  }),

  // ── Location ─────────────────────────────────────────────────────────
  "location.reported": defineEvent({
    description: "A location fix with device velocity. Always last-known, never live.",
    sensitivity: "location",
    incident: "optional",
    participant: "required",
    requiresConsent: ["location.group", "location.responders"],
    payload: v.object({
      latitude: v.number({ min: -90, max: 90 }),
      longitude: v.number({ min: -180, max: 180 }),
      accuracy_m: v.number({ min: 0 }),
      fix_at: v.timestamp(),
      source: v.enum(["gnss", "network", "synthetic"] as const),
      /** Ground speed from the OS (GNSS doppler). Distinguishes stationary, walking, in a vehicle. */
      speed_m_s: v.nullable(v.number({ min: 0 })),
      /** Direction of travel, degrees clockwise from true north; null when stationary or unknown. */
      heading_deg: v.nullable(v.number({ min: 0, max: 360 })),
      altitude_m: v.optional(v.number()),
      place_label: v.optional(shortText(120)),
    }),
    summarize: (d, ctx) =>
      // Coordinates are printed exactly; rounding would make the summary disagree with the data.
      `Location fix for ${who(ctx)} at ${d.fix_at}: ${d.latitude}, ${d.longitude} ` +
      `(±${num(d.accuracy_m)} m, ${d.source}${d.place_label ? `, "${d.place_label}"` : ""}); ` +
      (d.speed_m_s === null
        ? "speed unknown."
        : `speed ${num(d.speed_m_s)} m/s${d.heading_deg === null ? "" : ` heading ${num(d.heading_deg)}°`}.`),
  }),

  // ── Sensors and detection ────────────────────────────────────────────
  "sensor.stream_started": defineEvent({
    description:
      "A motion stream began. Records the sensor and every threshold once, so each later window " +
      "and detection can be interpreted exactly without repeating them.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      recording_id: v.id("rec"),
      sensor: v.enum(["accelerometer", "linear_acceleration"] as const),
      gravity_included: v.boolean(),
      device_kind: v.enum(["phone", "wearable", "synthetic"] as const),
      device_model: v.nullable(shortText()),
      sensor_name: v.nullable(shortText()),
      sensor_range_m_s2: v.number({ min: 0 }),
      nominal_rate_hz: v.nullable(v.number({ min: 0 })),
      window_ms: v.number({ min: 1000, integer: true }),
      features: v.object({
        still_m_s2: v.number({ min: 0 }),
        impact_m_s2: v.number({ min: 0 }),
        moderate_m_s2: v.number({ min: 0 }),
        vigorous_m_s2: v.number({ min: 0 }),
        still_window_ratio: v.number({ min: 0, max: 1 }),
      }),
      detector: v.object({
        calibration_windows: v.number({ min: 2, integer: true }),
        min_coverage: v.number({ min: 0, max: 1 }),
        anomaly_z: v.number(),
        min_stillness_ratio: v.number({ min: 0, max: 1 }),
        refractory_ms: ms(),
        impact_still_within_ms: ms(),
        prolonged_still_ms: ms(),
        tilt_change_deg: v.number({ min: 0, max: 180 }),
      }),
      thresholds_validated: v.literal(false),
    }),
    summarize: (d, ctx) =>
      `Motion stream ${d.recording_id} started for ${who(ctx)}: ${d.sensor}` +
      `${d.sensor_name ? ` (${d.sensor_name}` + (d.device_model ? `, ${d.device_model})` : ")") : ""}, ` +
      `${d.gravity_included ? "gravity included" : "gravity removed"}, range ${num(d.sensor_range_m_s2)} m/s^2, ` +
      `${duration(d.window_ms)} windows. Thresholds are unvalidated prototype settings.`,
  }),

  "sensor.motion_window": defineEvent({
    description:
      "Accelerometer features for one window, computed from a raw batch (provenance.raw_ref). " +
      "Emitted continuously so activity before and after an incident can be reconstructed.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      window_start: v.timestamp(),
      window_end: v.timestamp(),
      sample_count: v.number({ min: 1, integer: true }),
      /** Samples dropped by input validation (malformed, late, duplicate, ...). */
      rejected_sample_count: v.number({ min: 0, integer: true }),
      effective_rate_hz: v.nullable(v.number({ min: 0 })),
      /** Share of the window backed by data. Low coverage means low movement may be missing data. */
      coverage_ratio: v.number({ min: 0, max: 1 }),
      max_gap_ms: ms(),
      clipped_sample_count: v.number({ min: 0, integer: true }),
      /** Movement level: mean |a| beyond gravity. */
      dynamic_mean_m_s2: v.number({ min: 0 }),
      dynamic_std_m_s2: v.number({ min: 0 }),
      dynamic_peak_m_s2: v.number({ min: 0 }),
      stillness_ratio: v.number({ min: 0, max: 1 }),
      /** Longest continuous motionless stretch within the window. */
      longest_still_ms: ms(),
      /** Dominant movement rhythm (steps, dance beat); null when there is none. */
      cadence_hz: v.nullable(v.number({ min: 0 })),
      /** 0 = irregular, 1 = perfectly periodic. Unsteady gait or flailing reads low. */
      rhythm_regularity: v.nullable(v.number({ min: 0, max: 1 })),
      impact_count: v.number({ min: 0, integer: true }),
      impacts: v.array(
        v.object({
          at: v.timestamp(),
          peak_m_s2: v.number({ min: 0 }),
          /** The sensor saturated, so the true peak was higher. */
          clipped: v.boolean(),
        }),
        { maxLength: 5 },
      ),
      /** Device orientation; null for gravity-removed sensors. */
      gravity_vector_m_s2: v.nullable(v.array(v.number(), { minLength: 3, maxLength: 3 })),
      /** Rotation since the previous window (e.g. pocket -> flat on the ground). */
      tilt_change_deg: v.nullable(v.number({ min: 0, max: 180 })),
      activity_level: v.enum(["still", "light", "moderate", "vigorous"] as const),
    }),
    summarize: (d, ctx) => {
      const rhythm =
        d.cadence_hz === null ? "no rhythm" : `rhythm ${num(d.cadence_hz)} Hz (regularity ${num(d.rhythm_regularity ?? 0)})`;
      const peakImpact = d.impacts.reduce<(typeof d.impacts)[number] | null>(
        (m, i) => (m === null || i.peak_m_s2 > m.peak_m_s2 ? i : m),
        null,
      );
      const impacts =
        d.impact_count === 0 || !peakImpact
          ? "no impacts"
          : `${d.impact_count} impact(s), strongest ${num(peakImpact!.peak_m_s2)} m/s^2 at ${peakImpact!.at}` +
            (peakImpact!.clipped ? " (sensor saturated; true peak higher)" : "");
      return (
        `Motion ${d.window_start}–${d.window_end} for ${who(ctx)}: ${d.activity_level}; movement ` +
        `${num(d.dynamic_mean_m_s2)} ± ${num(d.dynamic_std_m_s2)} m/s^2, peak ${num(d.dynamic_peak_m_s2)}; ` +
        `still ${Math.round(d.stillness_ratio * 100)}% (longest ${duration(d.longest_still_ms)}); ${rhythm}; ${impacts}` +
        (d.tilt_change_deg === null ? "" : `; rotated ${Math.round(d.tilt_change_deg)}°`) +
        `; data covers ${Math.round(d.coverage_ratio * 100)}% of the window.`
      );
    },
  }),

  "sensor.motion_pattern_observed": defineEvent({
    description:
      "A sequence across windows worth a check-in, such as an impact followed by stillness. " +
      "An observation of movement, not a medical conclusion.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      pattern: v.enum([
        "impact_then_stillness",
        "abrupt_stop",
        "orientation_change_with_stillness",
        "prolonged_stillness",
      ] as const),
      observed_from: v.timestamp(),
      observed_to: v.timestamp(),
      rule: v.object({ id: shortText(), threshold_validated: v.literal(false) }),
      impact_at: v.optional(v.timestamp()),
      impact_peak_m_s2: v.optional(v.number({ min: 0 })),
      impact_peak_clipped: v.optional(v.boolean()),
      still_duration_ms: v.optional(ms()),
      preceding_activity: v.optional(v.enum(["still", "light", "moderate", "vigorous"] as const)),
      preceding_cadence_hz: v.optional(v.nullable(v.number({ min: 0 }))),
      tilt_change_deg: v.optional(v.number({ min: 0, max: 180 })),
    }),
    summarize: (d, ctx) => {
      const subject = cap(who(ctx));
      switch (d.pattern) {
        case "impact_then_stillness":
          return (
            `${subject}: impact of ${num(d.impact_peak_m_s2 ?? 0)} m/s^2 at ${d.impact_at}` +
            `${d.impact_peak_clipped ? " (sensor saturated; true peak higher)" : ""}, followed by ` +
            `${duration(d.still_duration_ms ?? 0)} of stillness. Movement observation only.`
          );
        case "abrupt_stop":
          return (
            `${subject}: ${d.preceding_activity} movement` +
            `${d.preceding_cadence_hz ? ` at ${num(d.preceding_cadence_hz)} Hz` : ""} stopped abruptly; still from ` +
            `${d.observed_from}. Movement observation only.`
          );
        case "orientation_change_with_stillness":
          return `${subject}: phone rotated ${Math.round(d.tilt_change_deg ?? 0)}° and then stayed still. Movement observation only.`;
        case "prolonged_stillness":
          return `${subject}: continuously still for ${duration(d.still_duration_ms ?? 0)} since ${d.observed_from}. Movement observation only.`;
      }
    },
  }),

  "sensor.baseline_calibrated": defineEvent({
    description: "Personal motion baseline: spread of each feature across calibration windows (listed in caused_by).",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      window_start: v.timestamp(),
      window_end: v.timestamp(),
      window_ms: ms(),
      sampling_rate_hz: v.number({ min: 0 }),
      device_kind: v.enum(["phone", "wearable", "synthetic"] as const),
      features: v.array(
        v.object({
          name: shortText(),
          unit: shortText(32),
          mean: v.number(),
          std_dev: v.number({ min: 0 }),
          window_count: v.number({ min: 2, integer: true }),
        }),
        { minLength: 1 },
      ),
    }),
    summarize: (d, ctx) =>
      `Motion baseline calibrated for ${who(ctx)} from ${d.window_start} to ${d.window_end} ` +
      `(${d.device_kind}, ${num(d.sampling_rate_hz)} Hz, ${duration(d.window_ms)} windows): ` +
      d.features.map((f) => `${f.name} ${num(f.mean)} ± ${num(f.std_dev)} ${f.unit} (n=${f.window_count})`).join("; ") +
      ".",
  }),

  "sensor.motion_anomaly_observed": defineEvent({
    description: "Detector observed a motion feature outside the personal baseline. An observation, not a diagnosis.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      feature: shortText(),
      unit: shortText(32),
      observed_value: v.number(),
      baseline_mean: v.number(),
      baseline_std_dev: v.number({ min: 0 }),
      z_score: v.number(),
      window_start: v.timestamp(),
      window_end: v.timestamp(),
      rule: v.object({
        id: shortText(),
        comparator: v.enum([">=", "<=", "abs>="] as const),
        threshold: v.number(),
        threshold_validated: v.literal(false),
      }),
    }),
    summarize: (d, ctx) =>
      `Motion observation for ${who(ctx)} between ${d.window_start} and ${d.window_end}: ` +
      `${d.feature} = ${num(d.observed_value)} ${d.unit} versus personal baseline ` +
      `${num(d.baseline_mean)} ± ${num(d.baseline_std_dev)} ${d.unit} (z = ${num(d.z_score)}), ` +
      `meeting rule ${d.rule.id} (z ${d.rule.comparator} ${num(d.rule.threshold)}, unvalidated). ` +
      `This is a movement observation only, not a medical conclusion.`,
  }),

  "sensor.stream_interrupted": defineEvent({
    description: "Sensor data stopped arriving.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({
      last_sample_at: v.timestamp(),
      reason: v.enum(["permission_revoked", "device_disconnected", "app_backgrounded", "unknown"] as const),
    }),
    summarize: (d, ctx) =>
      `Sensor data from ${who(ctx)} stopped; last sample at ${d.last_sample_at} (reason: ${d.reason}).`,
  }),

  "sensor.stream_resumed": defineEvent({
    description: "Sensor data resumed after an interruption.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    requiresConsent: ["monitoring"],
    payload: v.object({ gap_ms: ms() }),
    summarize: (d, ctx) => `Sensor data from ${who(ctx)} resumed after a ${duration(d.gap_ms)} gap.`,
  }),

  // ── Connectivity ─────────────────────────────────────────────────────
  "connectivity.device_offline": defineEvent({
    description: "Participant device stopped reaching the server. Registered timers keep running.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      last_seen_at: v.timestamp(),
      detected_by: v.enum(["heartbeat_timeout", "transport_error"] as const),
      heartbeat_interval_ms: v.optional(ms()),
    }),
    summarize: (d, ctx) =>
      `Device of ${who(ctx)} went offline (${d.detected_by}); last seen ${d.last_seen_at}. ` +
      `Pending timers continue server-side.`,
  }),

  "connectivity.device_online": defineEvent({
    description: "Participant device reconnected.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({ offline_duration_ms: ms() }),
    summarize: (d, ctx) => `Device of ${who(ctx)} reconnected after ${duration(d.offline_duration_ms)} offline.`,
  }),

  // ── Private check-ins ────────────────────────────────────────────────
  "checkin.prompted": defineEvent({
    description: "Private check-in sent to the participant.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      checkin_id: v.id("chk"),
      trigger: v.enum(["motion_anomaly", "motion_pattern", "scheduled", "manual"] as const),
      delivery: v.enum(["haptic", "notification", "in_app"] as const),
      response_deadline_at: v.timestamp(),
    }),
    summarize: (d, ctx) =>
      `Private check-in ${d.checkin_id} sent to ${who(ctx)} (${d.trigger}, via ${d.delivery}); ` +
      `response due by ${d.response_deadline_at}.`,
  }),

  "checkin.responded": defineEvent({
    description: "Participant answered a check-in. 'duress' looks like a cancel to onlookers but requests help.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      checkin_id: v.id("chk"),
      response: v.enum(["confirmed_ok", "requested_help", "duress"] as const),
      method: v.enum(["tap", "pin", "voice"] as const),
      latency_ms: ms(),
    }),
    summarize: (d, ctx) => {
      const what = {
        confirmed_ok: "responded OK",
        requested_help: "requested help",
        duress: "entered the duress signal (silent request for help)",
      }[d.response];
      return `${cap(who(ctx))} ${what} to check-in ${d.checkin_id} via ${d.method} after ${duration(d.latency_ms)}.`;
    },
  }),

  "checkin.missed": defineEvent({
    description: "Check-in deadline passed without a response.",
    sensitivity: "none",
    incident: "optional",
    participant: "required",
    payload: v.object({
      checkin_id: v.id("chk"),
      response_deadline_at: v.timestamp(),
    }),
    summarize: (d, ctx) =>
      `No response from ${who(ctx)} to check-in ${d.checkin_id} by its deadline ${d.response_deadline_at}.`,
  }),

  // ── Incident lifecycle ───────────────────────────────────────────────
  "incident.opened": defineEvent({
    description: "An incident was opened; this starts its escalation.",
    sensitivity: "none",
    incident: "required",
    participant: "required",
    payload: v.object({
      trigger: v.enum([
        "checkin_missed",
        "help_requested",
        "duress",
        "manual_host",
        "manual_participant",
      ] as const),
      trigger_event_id: evtId(),
    }),
    summarize: (d, ctx) => `Incident ${ctx.incident_id} opened for ${who(ctx)} (trigger: ${d.trigger}).`,
  }),

  "incident.acknowledged": defineEvent({
    description: "A responder acknowledged the alert. Confirms receipt only, not the participant's condition.",
    sensitivity: "none",
    incident: "required",
    participant: "required",
    payload: v.object({
      acknowledged_by_role: v.enum(RESPONDER_ROLES),
      acknowledged_by_id: shortText(),
      notification_id: v.id("ntf"),
    }),
    summarize: (d, ctx) =>
      `${cap(d.acknowledged_by_role.replace("_", " "))} ${d.acknowledged_by_id} acknowledged alert ` +
      `${d.notification_id} for incident ${ctx.incident_id}. Acknowledgment confirms receipt only; ` +
      `it does not indicate the participant's condition.`,
  }),

  "incident.resolved": defineEvent({
    description: "Incident closed. A separate action from acknowledgment.",
    sensitivity: "none",
    incident: "required",
    participant: "required",
    payload: v.object({
      resolution: v.enum([
        "false_alarm",
        "participant_confirmed_ok",
        "assistance_reached_participant",
        "other",
      ] as const),
      resolved_by_role: v.enum(["participant", "host", "backup_contact"] as const),
      resolved_by_id: shortText(),
    }),
    summarize: (d, ctx) =>
      `Incident ${ctx.incident_id} resolved as ${d.resolution} by ${d.resolved_by_role} ${d.resolved_by_id}.`,
  }),

  "incident.participant_update": defineEvent({
    description:
      "The person the alert is about added an update from their own phone. Self-reported: it neither acknowledges nor resolves the alert.",
    sensitivity: "none",
    incident: "required",
    participant: "required",
    selfActorOnly: true,
    payload: v.object({
      update: v.enum(["reported_ok"] as const),
      method: v.enum(["tap"] as const),
    }),
    summarize: (_d, ctx) =>
      `${cap(who(ctx))} reported from their own phone that they are OK (self-reported). ` +
      `The alert for incident ${ctx.incident_id} stays open until a responder resolves it.`,
  }),

  // ── Notifications (simulated transport) ──────────────────────────────
  "notification.sent": defineEvent({
    description: "Alert sent to a recipient. Lists exactly which facts were delivered.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({
      notification_id: v.id("ntf"),
      recipient_id: shortText(),
      recipient_role: v.enum(RECIPIENT_ROLES),
      channel: v.enum(["in_app_sim", "push_sim"] as const),
      escalation_step: v.number({ min: 1, integer: true }),
      attempt: v.number({ min: 1, integer: true }),
      is_repeat: v.boolean(),
      delivered_fact_event_ids: v.array(evtId()),
    }),
    refine: (d) =>
      d.is_repeat !== d.attempt > 1
        ? [{ path: "data.is_repeat", message: "must be true exactly when attempt > 1" }]
        : [],
    summarize: (d, ctx) =>
      `Alert ${d.notification_id} for incident ${ctx.incident_id} sent to ${d.recipient_role} ${d.recipient_id} ` +
      `via ${d.channel} (escalation step ${d.escalation_step}, attempt ${d.attempt}` +
      `${d.is_repeat ? ", repeat; escalation deadline unchanged" : ""}).`,
  }),

  "notification.delivered": defineEvent({
    description: "Simulated transport confirmed delivery to the recipient's device.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({ notification_id: v.id("ntf"), recipient_id: shortText() }),
    summarize: (d) => `Alert ${d.notification_id} delivered to ${d.recipient_id}.`,
  }),

  "notification.viewed": defineEvent({
    description: "Recipient opened the alert without necessarily acknowledging it.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({ notification_id: v.id("ntf"), recipient_id: shortText() }),
    summarize: (d) => `Alert ${d.notification_id} viewed by ${d.recipient_id} (not an acknowledgment).`,
  }),

  "notification.delivery_failed": defineEvent({
    description: "Delivery failed. Does not cancel the escalation deadline.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({
      notification_id: v.id("ntf"),
      recipient_id: shortText(),
      reason: v.enum(["recipient_offline", "transport_error", "simulated_failure"] as const),
      will_retry: v.boolean(),
    }),
    summarize: (d) =>
      `Alert ${d.notification_id} could not be delivered to ${d.recipient_id} (${d.reason}); ` +
      `${d.will_retry ? "will retry" : "no retry"}. Escalation deadline still applies.`,
  }),

  // ── Escalation scheduler ─────────────────────────────────────────────
  "escalation.step_scheduled": defineEvent({
    description: "Escalation step registered with a deadline anchored to the first unacknowledged alert.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({
      escalation_id: v.id("esc"),
      step: v.number({ min: 1, integer: true }),
      target_role: v.enum(RECIPIENT_ROLES),
      due_at: v.timestamp(),
      deadline_basis_event_id: evtId(),
    }),
    summarize: (d) =>
      `Escalation step ${d.step} (${d.target_role}) scheduled for ${d.due_at} unless the alert is acknowledged.`,
  }),

  "escalation.step_fired": defineEvent({
    description: "Escalation deadline passed without acknowledgment; the next recipient is alerted.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({
      escalation_id: v.id("esc"),
      step: v.number({ min: 1, integer: true }),
      target_role: v.enum(RECIPIENT_ROLES),
      scheduled_due_at: v.timestamp(),
      fired_late_ms: ms(),
    }),
    summarize: (d) =>
      `Escalation step ${d.step} (${d.target_role}) fired; it was due at ${d.scheduled_due_at}` +
      `${d.fired_late_ms > 0 ? ` and fired ${duration(d.fired_late_ms)} late` : ""}.`,
  }),

  "escalation.step_cancelled": defineEvent({
    description: "Pending escalation step cancelled.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    payload: v.object({
      escalation_id: v.id("esc"),
      step: v.number({ min: 1, integer: true }),
      reason: v.enum(["acknowledged", "resolved", "session_ended"] as const),
    }),
    summarize: (d) => `Escalation step ${d.step} cancelled (${d.reason}).`,
  }),

  // ── Simulated emergency services ─────────────────────────────────────
  "emergency.simulated_dispatch_requested": defineEvent({
    description: "Simulated request to emergency services via the mock operator. Never a real call.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      mock_endpoint_id: v.literal(MOCK_OPERATOR_ENDPOINT_ID),
      escalation_id: v.id("esc"),
      delivered_fact_event_ids: v.array(evtId()),
    }),
    summarize: (d, ctx) =>
      `SIMULATED emergency-service request for incident ${ctx.incident_id} sent to mock endpoint ` +
      `${d.mock_endpoint_id}. No real emergency service was contacted.`,
  }),

  // ── Voice agent (mock operator line) ─────────────────────────────────
  "voice.call_started": defineEvent({
    description: "Voice agent connected to the mock operator.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      mock_endpoint_id: v.literal(MOCK_OPERATOR_ENDPOINT_ID),
    }),
    summarize: (d) => `Simulated call ${d.call_id} to mock endpoint ${d.mock_endpoint_id} started.`,
  }),

  "voice.utterance": defineEvent({
    description: "One spoken turn on the call, either the agent's or the mock operator's.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      turn_index: v.number({ min: 0, integer: true }),
      speaker: v.enum(["voice_agent", "mock_operator"] as const),
      text: v.string({ minLength: 1, maxLength: 2000 }),
      /** Events that ground this utterance. Required for the agent's turns. */
      grounding_event_ids: v.array(evtId()),
      interrupted: v.boolean(),
    }),
    refine: (d) =>
      d.speaker === "voice_agent" && d.grounding_event_ids.length === 0
        ? [{ path: "data.grounding_event_ids", message: "agent utterances must cite at least one event" }]
        : [],
    summarize: (d) =>
      `[call ${d.call_id} turn ${d.turn_index}] ${d.speaker}${d.interrupted ? " (interrupted)" : ""}: "${d.text}"`,
  }),

  "voice.silence_detected": defineEvent({
    description: "No speech on the call for the given duration.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({ call_id: v.id("call"), duration_ms: ms() }),
    summarize: (d) => `Silence on call ${d.call_id} for ${duration(d.duration_ms)}.`,
  }),

  "voice.agent_interrupted": defineEvent({
    description: "The operator spoke over the agent, so playback of an agent turn stopped early.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      /** The agent turn that was cut off. */
      turn_index: v.number({ min: 0, integer: true }),
      /** How much of it played before the operator spoke. */
      heard_ms: ms(),
    }),
    summarize: (d) => `[call ${d.call_id} turn ${d.turn_index}] Operator interrupted the agent after ${duration(d.heard_ms)} of playback.`,
  }),

  "voice.draft_rejected": defineEvent({
    description: "A model-written reply that failed a grounding check and was not spoken.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      /** The operator turn the draft was answering. */
      turn_index: v.number({ min: 0, integer: true }),
      attempt: v.number({ min: 1, integer: true }),
      stage: v.enum(["schema", "guard", "judge", "judge_unavailable", "superseded"] as const),
      reasons: v.array(shortText(300), { minLength: 1, maxLength: 12 }),
      draft_text: v.optional(v.string({ minLength: 1, maxLength: 2000 })),
      model_id: v.optional(shortText()),
    }),
    summarize: (d) =>
      `[call ${d.call_id} turn ${d.turn_index}] Draft ${d.attempt} rejected at ${d.stage} check and not spoken: ${d.reasons.join("; ")}.`,
  }),

  "voice.agent_error": defineEvent({
    description: "The voice agent failed while on a call.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      error_code: shortText(),
      recoverable: v.boolean(),
    }),
    summarize: (d) =>
      `Voice agent error on call ${d.call_id}: ${d.error_code} (${d.recoverable ? "recoverable" : "not recoverable"}).`,
  }),

  "voice.call_ended": defineEvent({
    description: "Simulated call ended.",
    sensitivity: "none",
    incident: "required",
    participant: "optional",
    mustBeSimulated: true,
    payload: v.object({
      call_id: v.id("call"),
      reason: v.enum(["completed", "operator_hangup", "disconnected", "agent_failure", "timeout"] as const),
      duration_ms: ms(),
    }),
    summarize: (d) => `Simulated call ${d.call_id} ended (${d.reason}) after ${duration(d.duration_ms)}.`,
  }),
} as const;

export type EventCatalog = typeof EVENT_CATALOG;
export type EventType = keyof EventCatalog;
export type PayloadOf<T extends EventType> = Infer<EventCatalog[T]["payload"]>;
export type Category = EventType extends `${infer C}.${string}` ? C : never;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.hasOwn(EVENT_CATALOG, value);
}

export function categoryOf<T extends EventType>(type: T): Category {
  return type.slice(0, type.indexOf(".")) as Category;
}

export function specFor<T extends EventType>(type: T): EventSpec<PayloadOf<T>> {
  return EVENT_CATALOG[type] as unknown as EventSpec<PayloadOf<T>>;
}

export interface EnvelopeFields {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  /** Gap-free position within the session timeline, starting at 1. */
  seq: number;
  category: Category;
  session_id: string;
  incident_id: string | null;
  /** The participant the event is about (not necessarily the actor). */
  participant_id: string | null;
  /** When it happened in the world (e.g. sensor window end). */
  occurred_at: string;
  /** When the timeline recorded it, from the injected clock. */
  recorded_at: string;
  actor: Actor;
  provenance: Provenance;
  /** Earlier events this one was caused by (e.g. check-in ← anomaly). */
  caused_by: string[];
  /** Deterministic human-readable rendering of data. */
  summary: string;
  /** Hash of the previous event in this timeline; null for the first. */
  prev_hash: string | null;
  /** sha256 over the canonical form of every other field. */
  hash: string;
}

type EventUnion = {
  [K in EventType]: EnvelopeFields & { type: K; data: PayloadOf<K> };
}[EventType];

/**
 * A timeline event, discriminated on `type` so `data` narrows automatically.
 * Defined via Extract so TimelineEvent<T> is always assignable to TimelineEvent.
 */
export type TimelineEvent<T extends EventType = EventType> = Extract<EventUnion, { type: T }>;

const envelopeSchema = v.object({
  schema_version: v.literal(SCHEMA_VERSION),
  event_id: evtId(),
  seq: v.number({ min: 1, integer: true }),
  type: v.string(),
  category: v.string(),
  session_id: v.id("ses"),
  incident_id: v.nullable(v.id("inc")),
  participant_id: v.nullable(parId()),
  occurred_at: v.timestamp(),
  recorded_at: v.timestamp(),
  actor: actorSchema,
  provenance: provenanceSchema,
  caused_by: v.array(evtId()),
  data: v.unknown(),
  summary: v.string({ minLength: 1 }),
  prev_hash: v.nullable(v.string({ pattern: /^sha256:[0-9a-f]{64}$/ })),
  hash: v.string({ pattern: /^sha256:[0-9a-f]{64}$/ }),
});

/** Fields a caller supplies; the timeline fills in the rest. */
export interface ScopedFields {
  type: string;
  incident_id: string | null;
  participant_id: string | null;
  actor: Actor;
  provenance: Provenance;
  data: unknown;
}

/**
 * Checks the type-specific rules from the catalog: payload schema,
 * incident/participant scoping, simulation flag, self-consent and refine().
 */
export function checkTypedFields(fields: ScopedFields): Issue[] {
  if (!isEventType(fields.type)) return [{ path: "type", message: `unknown event type "${fields.type}"` }];
  const spec = specFor(fields.type);
  const issues = validate(spec.payload, fields.data, "data");
  if (spec.incident === "required" && fields.incident_id === null) {
    issues.push({ path: "incident_id", message: `required for ${fields.type}` });
  }
  if (spec.participant === "required" && fields.participant_id === null) {
    issues.push({ path: "participant_id", message: `required for ${fields.type}` });
  }
  if (spec.mustBeSimulated && !fields.provenance.simulated) {
    issues.push({ path: "provenance.simulated", message: `${fields.type} must be simulated` });
  }
  if (
    spec.selfActorOnly &&
    !((fields.actor.kind === "participant" || fields.actor.kind === "host") && fields.actor.id === fields.participant_id)
  ) {
    issues.push({ path: "actor", message: `${fields.type} may only be performed by the participant themselves` });
  }
  if (issues.length === 0 && spec.refine) issues.push(...spec.refine(fields.data as never));
  return issues;
}

/** Full structural check of a stored event (envelope, payload, catalog rules, summary). */
export function checkEvent(raw: unknown): Issue[] {
  const issues = validate(envelopeSchema, raw);
  if (issues.length > 0) return issues;
  const event = raw as TimelineEvent;
  issues.push(...checkTypedFields(event));
  if (issues.length > 0) return issues;
  if (event.category !== categoryOf(event.type)) {
    issues.push({ path: "category", message: `expected "${categoryOf(event.type)}"` });
  }
  const expected = renderSummary(event.type, event.data, event);
  if (event.summary !== expected) issues.push({ path: "summary", message: "does not match the rendered payload" });
  return issues;
}

export function renderSummary<T extends EventType>(type: T, data: PayloadOf<T>, ctx: SummaryContext): string {
  return specFor(type).summarize(data, { participant_id: ctx.participant_id, incident_id: ctx.incident_id });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
