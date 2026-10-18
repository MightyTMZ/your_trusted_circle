/**
 * Fact sheet: the only things the voice agent is allowed to say.
 *
 * Code, not the model, turns the operator briefing (and the evidence events
 * it permits) into short, pre-worded statements: "F7: Last-known location
 * ...". Every number, time and name the agent may speak is written here,
 * deterministically, from a cited timeline event. The model's job is to pick
 * facts and phrase them; guard.ts rejects any sentence that carries a value
 * not present in the facts it cites.
 *
 * Consent filtering already happened in buildOperatorBriefing: data the
 * participant did not share never reaches this file.
 */
import { parseIso } from "../shared/clock.js";
import type { OperatorBriefing } from "../timeline/briefing.js";
import type { PayloadOf, TimelineEvent } from "../timeline/schema/catalog.js";

export type FactTopic =
  | "scope"
  | "identity"
  | "notes"
  | "location"
  | "location_history"
  | "incident"
  | "checkin"
  | "motion"
  | "motion_history"
  | "device"
  | "alerts"
  | "escalation"
  | "condition"
  | "description"
  | "contact_details";

export interface Fact {
  /** Stable within one sheet: F1, F2, ... */
  id: string;
  topic: FactTopic;
  /** observed: recorded by the system; derived: computed from records; unknown: an explicit gap; policy: what the agent is. */
  kind: "observed" | "derived" | "unknown" | "policy";
  /** One or two speakable sentences. Times are local wall-clock. */
  text: string;
  /** Timeline events this statement rests on. Never empty. */
  source_event_ids: string[];
  /** Extra retrieval terms (operator vocabulary). Never spoken. */
  keywords: string[];
  /** Leads its topic in the call's opening breakdown (e.g. the impact among motion facts). */
  headline?: boolean;
}

export interface FactSheet {
  incident_id: string;
  generated_at: string;
  time_zone: string;
  facts: Fact[];
}

export interface FactSheetOptions {
  /** IANA zone used to speak times, e.g. "America/Toronto". */
  timeZone: string;
  /** Older location fixes to include besides the last-known one. Default 4. */
  locationTrail?: number;
  /** Most recent activity segments to include. Default 8. */
  historySegments?: number;
}

const KEYWORDS: Record<FactTopic, string[]> = {
  scope: ["record", "share", "information"],
  identity: ["name", "who", "person", "patient", "caller", "language", "speak", "pronouns", "called"],
  notes: ["medical", "conditions", "allergies", "allergic", "medication", "medicine", "history", "notes", "health", "inhaler", "asthma"],
  location: ["where", "address", "location", "located", "place", "venue", "coordinates", "gps", "find", "street", "now"],
  location_history: ["before", "earlier", "route", "path", "came", "previous"],
  incident: ["happened", "happening", "situation", "why", "calling", "problem", "wrong", "reason"],
  checkin: ["respond", "responded", "answer", "answered", "reply", "checked", "message", "prompt", "contact", "reach"],
  // copy-guard: allow (operator words that route to motion facts; never spoken)
  motion: ["moving", "movement", "motion", "still", "impact", "fall", "fell", "dropped", "hit", "jolt", "accelerometer", "sensor", "active"],
  motion_history: ["before", "earlier", "night", "tonight", "evening", "doing", "dancing", "walking", "sitting", "activity", "history", "timeline"],
  device: ["phone", "device", "battery", "offline", "online", "signal", "connection", "connected"],
  contact_details: ["number", "call", "contact", "reach", "email", "text", "cell", "mobile", "dial"],
  alerts: ["who", "friend", "friends", "host", "contact", "contacts", "family", "notified", "alerted", "told", "someone", "anyone", "acknowledged"],
  escalation: ["escalated", "escalation", "steps", "timeline", "sequence"],
  condition: ["conscious", "unconscious", "breathing", "awake", "responsive", "injured", "injury", "hurt", "bleeding", "drunk", "drugs", "drugged", "alcohol", "intoxicated", "safe", "okay", "ok", "alive", "cause", "condition", "pulse", "medical"],
  description: ["look", "looks", "description", "describe", "wearing", "clothes", "clothing", "age", "old", "height", "hair", "with", "alone", "anyone"],
};

const ROLE_NAME: Record<string, string> = {
  host: "the session host",
  backup_contact: "a backup contact",
  emergency_service_sim: "simulated emergency services",
  participant: "the participant",
};

const TRIGGER_TEXT: Record<PayloadOf<"incident.opened">["trigger"], string> = {
  checkin_missed: "a private check-in went unanswered",
  help_requested: "the participant chose \"I need help\" in the app",
  duress: "the participant used the app's silent duress signal",
  manual_host: "the session host raised it manually",
  manual_participant: "the participant raised it manually",
};

const RESPONSE_TEXT: Record<PayloadOf<"checkin.responded">["response"], string> = {
  confirmed_ok: "confirmed OK",
  requested_help: "chose \"I need help\"",
  duress: "used the silent duress signal",
};

const RESOLUTION_TEXT: Record<PayloadOf<"incident.resolved">["resolution"], string> = {
  false_alarm: "a false alarm",
  participant_confirmed_ok: "the participant confirmed they were OK",
  assistance_reached_participant: "assistance reached the participant",
  other: "another reason",
};

const ACTIVITY_TEXT = {
  still: "no movement (still)",
  light: "light movement",
  moderate: "moderate movement",
  vigorous: "vigorous movement",
  no_data: "no motion data (the phone was not sending readings)",
} as const;

const G = 9.80665;

export function buildFactSheet(
  briefing: OperatorBriefing,
  evidence: readonly TimelineEvent[],
  opts: FactSheetOptions,
): FactSheet {
  const now = parseIso(briefing.generated_at)!;
  const tz = opts.timeZone;
  const time = (iso: string) => speakTime(iso, tz);
  const ago = (iso: string) => speakDuration(Math.max(0, now - parseIso(iso)!));
  const facts: Omit<Fact, "id">[] = [];
  const add = (topic: FactTopic, kind: Fact["kind"], text: string, sources: (string | null | undefined)[]) => {
    const source_event_ids = [...new Set(sources.filter((s): s is string => !!s))];
    if (source_event_ids.length === 0) throw new Error(`fact without a source: ${text}`);
    facts.push({ topic, kind, text, source_event_ids, keywords: KEYWORDS[topic] });
    return facts.at(-1)!;
  };
  const incidentRef = briefing.incident.source_event_id;
  const byId = new Map(evidence.map((e) => [e.event_id, e]));

  // ── What the agent is ───────────────────────────────────────────────
  add(
    "scope",
    "policy",
    "I am an automated assistant and can only share what is in this incident's record; anything not in it is unknown to me. I can tell you the last-known location, what the app recorded, and who has been alerted.",
    [incidentRef],
  );

  // ── Who ─────────────────────────────────────────────────────────────
  const person = briefing.person;
  if (person.details) {
    const d = person.details;
    const parts = [d.display_name ? `The participant's name, as they entered it, is ${d.display_name}.` : "The participant did not provide a name."];
    if (d.pronouns) parts.push(`Their pronouns are ${d.pronouns}.`);
    // English is assumed on the call; only another language is worth saying.
    if (d.preferred_language && !/^en(glish)?\b/i.test(d.preferred_language.trim())) parts.push(`Their preferred language is ${d.preferred_language}.`);
    add("identity", "observed", parts.join(" "), [d.source_event_id]);
    if (d.emergency_notes) {
      add("notes", "observed", `They wrote this note for responders (self-reported, not verified): "${d.emergency_notes}"`, [d.source_event_id]);
    } else {
      add("notes", "unknown", "They did not share any medical or emergency notes, so their medical history is unknown.", [d.source_event_id]);
    }
  } else if (person.status === "not_consented") {
    add("identity", "unknown", "The participant has not consented to share their name or personal details with responders, so I cannot give them.", [incidentRef]);
  } else {
    add("identity", "unknown", "The participant's name and personal details have not been provided.", [incidentRef]);
  }
  add(
    "description",
    "unknown",
    "No physical description, age, or clothing is recorded, and whether anyone is physically with them is unknown.",
    [person.details?.source_event_id ?? incidentRef],
  );
  add(
    "contact_details",
    "unknown",
    "The participant's phone number and other contact details are not part of the record shared with me, so I cannot give them.",
    [person.details?.source_event_id ?? incidentRef],
  );

  // ── Where ───────────────────────────────────────────────────────────
  const loc = briefing.location;
  if (loc.last_known) {
    const l = loc.last_known;
    const coords = `coordinates ${l.latitude}, ${l.longitude}, accurate to about ${Math.round(l.accuracy_m)} metres`;
    const movement =
      l.speed_m_s === null
        ? ""
        : l.speed_m_s < 0.2
          ? " The phone was not moving at that fix."
          : ` The phone was moving at ${round(l.speed_m_s, 1)} metres per second${l.heading_deg === null ? "" : `, heading ${compass(l.heading_deg)}`}.`;
    // Spoken first: the place and how old it is. Coordinates and movement follow on request,
    // unless there is no place name, when the coordinates are the location.
    add(
      "location",
      "observed",
      `Last-known location, not live: ${l.place_label ?? coords}, recorded at ${time(l.fix_at)}, ${ago(l.fix_at)} ago. Their current location is unknown.`,
      [l.source_event_id],
    );
    add(
      "location",
      "observed",
      `${l.place_label ? `Last-known coordinates: ${coords.slice("coordinates ".length)}.` : "No place name was recorded with the last-known location."}${movement} No street address is recorded, only coordinates and a place name.`,
      [l.source_event_id],
    );
    const trail = evidence
      .filter((e): e is TimelineEvent<"location.reported"> => e.type === "location.reported" && e.event_id !== l.source_event_id)
      .slice(-(opts.locationTrail ?? 4));
    for (const fix of trail) {
      const d = fix.data;
      add(
        "location_history",
        "observed",
        `Earlier location fix at ${time(d.fix_at)}: ${d.place_label ? `${d.place_label}, ` : ""}coordinates ${d.latitude}, ${d.longitude}, accurate to about ${Math.round(d.accuracy_m)} metres.`,
        [fix.event_id],
      );
    }
  } else if (loc.status === "not_consented") {
    add("location", "unknown", "The participant has not consented to share their location with responders, so I cannot give it. Their location is unknown to me.", [incidentRef]);
  } else {
    add("location", "unknown", "No location has been reported, so their location is unknown.", [incidentRef]);
  }

  // ── What happened ───────────────────────────────────────────────────
  const inc = briefing.incident;
  add(
    "incident",
    "observed",
    `The app opened this safety alert at ${time(inc.opened_at)} because ${TRIGGER_TEXT[inc.trigger]}.`,
    [incidentRef, byId.get(incidentRef)?.type === "incident.opened" ? (byId.get(incidentRef) as TimelineEvent<"incident.opened">).data.trigger_event_id : null],
  );
  add(
    "condition",
    "unknown",
    "Their condition is unknown. The app only records phone movement and app activity; it has no information about consciousness, breathing, injuries, medical history, intoxication, drugs, or what caused any of this, and it cannot tell what they were doing or anything about their safety.",
    [incidentRef],
  );

  for (const e of evidence) {
    if (e.type === "checkin.prompted") {
      const answer = evidence.find(
        (r): r is TimelineEvent<"checkin.responded"> => r.type === "checkin.responded" && r.data.checkin_id === e.data.checkin_id,
      );
      const missed = evidence.find(
        (r): r is TimelineEvent<"checkin.missed"> => r.type === "checkin.missed" && r.data.checkin_id === e.data.checkin_id,
      );
      const why = e.data.trigger === "motion_anomaly" || e.data.trigger === "motion_pattern" ? "after a change in phone movement" : `(${e.data.trigger})`;
      if (answer) {
        add(
          "checkin",
          "observed",
          `At ${time(e.occurred_at)} the app sent a private check-in ${why}; the participant ${RESPONSE_TEXT[answer.data.response]} ${speakDuration(answer.data.latency_ms)} later.`,
          [e.event_id, answer.event_id],
        );
      } else if (missed) {
        add(
          "checkin",
          "observed",
          `At ${time(e.occurred_at)} the app sent a private check-in ${why}; there was no response by the ${time(e.data.response_deadline_at)} deadline.`,
          [e.event_id, missed.event_id],
        );
      } else {
        add(
          "checkin",
          "observed",
          `At ${time(e.occurred_at)} the app sent a private check-in ${why}; it has not been answered (deadline ${time(e.data.response_deadline_at)}).`,
          [e.event_id],
        );
      }
    }
  }

  for (const e of evidence) {
    if (e.type !== "incident.participant_update") continue;
    add(
      "checkin",
      "observed",
      `At ${time(e.occurred_at)} the participant reported from their own phone that they are OK. That is their own report: the app cannot confirm their condition, and the alert stays open until a responder resolves it.`,
      [e.event_id],
    );
  }

  // ── Movement ────────────────────────────────────────────────────────
  // The opening breakdown leads with the latest impact, else the baseline observation.
  let impactFact: Omit<Fact, "id"> | undefined;
  let observationFact: Omit<Fact, "id"> | undefined;
  for (const p of briefing.motion.patterns) {
    const from = time(p.observed_from);
    const to = time(p.observed_to);
    if (p.pattern === "impact_then_stillness" && p.impact_at && p.impact_peak_m_s2 !== undefined) {
      impactFact = add(
        "motion",
        "observed",
        `At ${time(p.impact_at)} the phone recorded a sudden impact, followed by ${speakDuration(p.still_duration_ms ?? 0)} with no movement. The app cannot tell what caused it.`,
        [p.source_event_id],
      );
      // The strength, for an operator who asks: kept out of the headline to keep it short.
      add(
        "motion",
        "observed",
        p.impact_peak_clipped
          ? `The impact at ${time(p.impact_at)} exceeded the phone sensor's measuring range: at least ${round(p.impact_peak_m_s2, 1)} m/s², about ${round(p.impact_peak_m_s2 / G, 1)} g; the true strength is unknown.`
          : `The impact at ${time(p.impact_at)} measured ${round(p.impact_peak_m_s2, 1)} m/s², about ${round(p.impact_peak_m_s2 / G, 1)} g.`,
        [p.source_event_id],
      );
    } else if (p.pattern === "abrupt_stop") {
      add("motion", "observed", `Between ${from} and ${to} ${p.preceding_activity ?? "active"} movement stopped abruptly and the phone became still.`, [p.source_event_id]);
    } else if (p.pattern === "orientation_change_with_stillness") {
      add("motion", "observed", `Between ${from} and ${to} the phone turned by about ${Math.round(p.tilt_change_deg ?? 0)} degrees and then stayed still.`, [p.source_event_id]);
    } else if (p.pattern === "prolonged_stillness") {
      add("motion", "observed", `From ${from} to ${to} the phone stayed still for ${speakDuration(p.still_duration_ms ?? 0)}.`, [p.source_event_id]);
    }
  }
  const obs = briefing.motion.observation;
  if (obs) {
    observationFact = add(
      "motion",
      "derived",
      `Between ${time(obs.window_start)} and ${time(obs.window_end)} phone movement was far below this person's usual level earlier in the night (${round(Math.abs(obs.z_score), 0)} standard deviations below their own baseline). This is a movement observation, not a medical finding.`,
      [obs.source_event_id, briefing.motion.baseline?.source_event_id],
    );
  }
  const lead = impactFact ?? observationFact;
  if (lead) lead.headline = true;
  const w = briefing.motion.latest_window;
  if (w) {
    add(
      "motion",
      "observed",
      `The most recent motion reading ends at ${time(w.window_end)}, ${ago(w.window_end)} ago: ${ACTIVITY_TEXT[w.activity_level]}, with ${Math.round(w.coverage_ratio * 100)}% of the expected sensor data.`,
      [w.source_event_id],
    );
    if (w.age_ms > 2 * 60_000) {
      add("motion", "unknown", `No motion data has arrived since ${time(w.window_end)}, so how the phone has moved since then is unknown.`, [w.source_event_id]);
    }
  } else {
    add("motion", "unknown", "No recent motion data is available.", [incidentRef]);
  }
  const history = briefing.motion.history;
  for (const s of history.segments.slice(-(opts.historySegments ?? 8))) {
    const sources = [s.first_event_id, s.last_event_id];
    // no_data segments have no windows to cite; they rest on the stream around them.
    if (!s.first_event_id) sources.push(briefing.motion.config_source_event_id);
    const rhythm = s.median_cadence_hz ? `, with a repeating rhythm of about ${round(s.median_cadence_hz, 1)} per second` : "";
    const impacts = s.impact_count > 0 ? `, and ${s.impact_count} impact${s.impact_count === 1 ? "" : "s"}` : "";
    add(
      "motion_history",
      "derived",
      `From ${time(s.from)} to ${time(s.to)} (${speakDuration(s.duration_ms)}) the phone showed ${ACTIVITY_TEXT[s.activity]}${rhythm}${impacts}.`,
      sources,
    );
  }

  // ── Phone ───────────────────────────────────────────────────────────
  const dev = briefing.device;
  if (dev.status === "offline" && dev.since) {
    const ev = dev.source_event_id ? byId.get(dev.source_event_id) : undefined;
    const lastSeen = ev?.type === "connectivity.device_offline" ? (ev as TimelineEvent<"connectivity.device_offline">).data.last_seen_at : dev.since;
    add("device", "observed", `The phone stopped reaching the app's server; it was last seen at ${time(lastSeen)} and has been offline for ${ago(lastSeen)}.`, [dev.source_event_id]);
  } else if (dev.status === "online" && dev.since) {
    add("device", "observed", `The phone has been connected to the app's server since ${time(dev.since)}.`, [dev.source_event_id]);
  } else {
    add("device", "unknown", "Whether the phone is currently connected is unknown.", [incidentRef]);
  }

  // ── Who has been told ───────────────────────────────────────────────
  const notificationEvents = (id: string) =>
    evidence.filter((e) => (e.data as { notification_id?: unknown }).notification_id === id).map((e) => e.event_id);
  for (const a of briefing.alerts) {
    const status = a.acknowledged
      ? "acknowledged it"
      : a.delivery_failed
        ? "it could not be delivered"
        : a.viewed
          ? "it was opened but not acknowledged"
          : a.delivered
            ? "it was delivered but not acknowledged"
            : "delivery is not confirmed";
    add(
      "alerts",
      "observed",
      `${cap(ROLE_NAME[a.recipient_role] ?? "a recipient")} was alerted at ${time(a.first_sent_at)}${a.attempts > 1 ? ` (${a.attempts} attempts)` : ""}; ${status}.`,
      notificationEvents(a.notification_id),
    );
  }
  if (inc.acknowledged) {
    add(
      "alerts",
      "observed",
      `${cap(ROLE_NAME[inc.acknowledged.by_role] ?? "a responder")} acknowledged the alert at ${time(inc.acknowledged.at)}. Acknowledging means they received it; it is not a confirmation of the participant's safety.`,
      [inc.acknowledged.source_event_id],
    );
  } else {
    add("alerts", "unknown", "Nobody has acknowledged the alert, so it is unknown whether anyone is on the way to them.", [incidentRef, ...briefing.alerts.flatMap((a) => notificationEvents(a.notification_id))]);
  }
  if (inc.resolved) {
    add(
      "incident",
      "observed",
      `${cap(ROLE_NAME[inc.resolved.by_role] ?? "a responder")} marked the alert resolved at ${time(inc.resolved.at)}, recording ${RESOLUTION_TEXT[inc.resolved.resolution as keyof typeof RESOLUTION_TEXT] ?? "a resolution"}.`,
      [inc.resolved.source_event_id],
    );
  }

  // ── Escalation ──────────────────────────────────────────────────────
  for (const f of briefing.escalation.fired) {
    add("escalation", "observed", `Escalation step ${f.step} (${ROLE_NAME[f.target_role] ?? f.target_role}) started at ${time(f.at)} because the alert was still unacknowledged.`, [f.source_event_id]);
  }
  for (const p of briefing.escalation.pending) {
    add("escalation", "observed", `Escalation step ${p.step} (${ROLE_NAME[p.target_role] ?? p.target_role}) is due at ${time(p.due_at)} unless someone acknowledges the alert.`, [p.source_event_id]);
  }

  return {
    incident_id: briefing.incident_id,
    generated_at: briefing.generated_at,
    time_zone: tz,
    facts: facts.map((f, i) => ({ id: `F${i + 1}`, ...f })),
  };
}

/** "11:50 PM EDT" (minutes are precise enough to speak). Narrow and no-break spaces from ICU are normalized so the guard can match text exactly. */
export function speakTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" })
    .format(parseIso(iso)!)
    .replace(/[  ]/g, " ");
}

/** "45 seconds", "about 13 minutes", "about 1 hour 18 minutes". */
export function speakDuration(msValue: number): string {
  const s = Math.round(msValue / 1000);
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `about ${m} minutes`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

function compass(deg: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return names[Math.round(deg / 45) % 8]!;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Renders the sheet for a prompt: one fact per line. */
export function factSheetToText(sheet: FactSheet): string {
  return sheet.facts.map((f) => `${f.id} [${f.topic}${f.kind === "unknown" ? ", unknown" : ""}] ${f.text}`).join("\n");
}
