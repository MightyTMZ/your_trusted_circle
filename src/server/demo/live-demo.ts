/**
 * Live incident demo: a presenter tool, on only with DEMO_INCIDENTS or the
 * localhost test sign-in (config.demoIncidents).
 *
 * It is a scenario script in the sense of CLAUDE.md and supplies inputs only:
 * synthetic accelerometer samples for one participant who has turned on
 * movement check-ins, run through the real SensorPipeline and detectors.
 *
 *   history (pre-dated, about 90 min, compressed into the trigger instant)
 *     arrive walking -> sitting -> phone on a table (check-in, answered OK)
 *     -> dancing -> standing -> walking
 *   live (real time)
 *     walking, a hard impact about five seconds after the trigger, then stillness
 *
 * Everything after that is the server's own work: whether the detector fires,
 * the private check-in and its deadline, the incident, every alert and
 * escalation step (safety/, driven by the scheduler). The participant's real
 * phone shows the check-in; the host's phone gets the alert.
 *
 * The demo keeps the incident's canonical record (src/timeline): the
 * synthetic history, the detections, and a mirror of what the server did.
 * When escalation reaches simulated emergency services it places a ringing
 * call (voice/calls.ts) whose agent reads this same record, so the agent can
 * only say what happened in this demo. No real call is possible.
 *
 * Memory only, like the location relay. The database holds only what the
 * server keeps anyway: the check-in, the incident and its log.
 */
import { MOCK_OPERATOR_ENDPOINT_ID, type ConsentScope, type Provenance } from "../../timeline/schema/envelope.js";
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import { Timeline } from "../../timeline/timeline.js";
import { SensorPipeline } from "../../sensors/pipeline.js";
import { ORIENTATION, addImpact, seeded, synthesize, type Motion, type Vec3 } from "../../sensors/synthetic.js";
import type { Sample } from "../../sensors/stream.js";
import { toIso, type Clock } from "../../shared/clock.js";
import type { Deps } from "../context.js";
import { newId } from "../ids.js";
import type { CheckInDoc, IncidentDoc, NotificationJobDoc, ParticipantDoc, SessionDoc, SessionRules } from "../types.js";
import type { CallService } from "../voice/calls.js";

/** Unvalidated demo values, short enough for a four-minute demo. Applied to the session's rules on start. */
export const DEMO_RULES = { checkInWindowSec: 20, hostAckWindowSec: 30, backupAckWindowSec: 30 } as const satisfies Partial<SessionRules>;

/** A public place, used when the host has not set a demo venue (matches src/ui/venue.ts). */
export const FALLBACK_VENUE = { label: "Toronto City Hall", lat: 43.6532, lng: -79.3832 };

const SCENARIO = "live-demo-v1";
const WINDOW_MS = 15_000;
const RATE_HZ = 25;
const SENSOR_RANGE = 156.9064;
const MINUTE = 60_000;
/** How long before the trigger the synthetic evening starts. */
const HISTORY_MS = 90 * MINUTE;
/** The impact comes at least this long after the trigger. */
const LEAD_MS = 5_000;
/** The phone stays still this long after the impact, then stops sending samples. */
const STILL_FOR_MS = 10 * MINUTE;

export type DemoPhase =
  | "before_impact"
  | "watching"
  | "checkin_pending"
  | "answered_ok"
  | "incident_open"
  | "calling"
  | "on_call"
  | "acknowledged"
  | "resolved"
  | "stopped";

const FINISHED: ReadonlySet<DemoPhase> = new Set(["answered_ok", "resolved", "stopped"]);

export interface DemoView {
  sessionId: string;
  participantId: string;
  name: string;
  phase: DemoPhase;
  startedAt: string;
  impactAt: string;
  checkIn: { id: string; dueAt: string; status: CheckInDoc["status"] } | null;
  incidentId: string | null;
  call: { id: string; status: "ringing" | "active" | "ended" } | null;
  timelineEvents: number;
  rules: typeof DEMO_RULES;
  stoppedReason: string | null;
}

export class DemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

const prov = (component: Provenance["component"], simulated = false): Provenance => ({
  component,
  data_origin: "synthetic_scenario",
  simulated,
  scenario_id: SCENARIO,
});

/** One demo per session, held in memory. */
export class DemoRegistry {
  private readonly runs = new Map<string, LiveDemo>();

  constructor(private readonly calls: CallService) {}

  async start(deps: Deps, session: SessionDoc, subjectId: string): Promise<LiveDemo> {
    const current = this.runs.get(session._id);
    if (current && !current.finished) throw new DemoError("demo_running", "A demo is already running in this session. Stop it first.");
    if (current?.finished) await this.restoreRules(deps, current);
    const subject = session.participants.find((p) => p.participantId === subjectId && p.leftAt === null);
    if (!subject) throw new DemoError("no_participant", "That person is not in this session.", 404);
    // Consent is theirs alone (CLAUDE.md): the host cannot turn on monitoring for them.
    if (!subject.consent.monitoring) {
      throw new DemoError("monitoring_off", `${subject.displayName} has movement check-ins turned off. Only they can turn them on.`);
    }
    if (await deps.store.findActiveIncident(session._id, subject.participantId)) {
      throw new DemoError("incident_open", `An alert about ${subject.displayName} is already open. Resolve it first.`);
    }
    if (await deps.store.findPendingCheckIn(session._id, subject.participantId)) {
      throw new DemoError("checkin_pending", `${subject.displayName} already has a check-in waiting. Let it finish first.`);
    }
    // Everyone who shares location appears on the map: phones report a simulated position at the venue.
    const rules: SessionRules = { ...session.rules, ...DEMO_RULES, demoVenue: session.rules.demoVenue ?? FALLBACK_VENUE };
    await deps.store.setSessionRules(session._id, rules);
    const run = new LiveDemo({ ...session, rules }, subject, deps.now().getTime(), this.calls, session.rules, rules);
    this.runs.set(session._id, run);
    return run;
  }

  get(sessionId: string): LiveDemo | undefined {
    return this.runs.get(sessionId);
  }

  async stop(deps: Deps, sessionId: string, reason: string): Promise<LiveDemo | undefined> {
    const run = this.runs.get(sessionId);
    if (run) {
      run.stop(reason);
      await this.restoreRules(deps, run);
    }
    return run;
  }

  private async restoreRules(deps: Deps, run: LiveDemo): Promise<void> {
    const session = await deps.store.getSession(run.sessionId);
    if (!session || !sameRules(session.rules, run.appliedRules)) return;
    await deps.store.setSessionRules(run.sessionId, run.previousRules);
  }

  /** Called once per scheduler pass (main.ts). One failing demo never stops the others. */
  async tick(deps: Deps): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.finished) continue;
      try {
        await run.step(deps);
      } catch (err) {
        console.error(`[demo] ${run.sessionId} failed: ${(err as Error).name}: ${(err as Error).message}`);
        run.stop("The demo hit an internal error.");
      }
    }
  }
}

interface Segment {
  motion: Motion;
  gravity: Vec3;
}

export class LiveDemo {
  readonly sessionId: string;
  readonly timeline: Timeline;
  private subject: ParticipantDoc;
  private readonly hostParticipantId: string | null;
  private readonly startedAt: number;
  private readonly historyStart: number;
  /** Two seconds before a window boundary, so the impact's window closes right after it. */
  readonly impactAt: number;
  private readonly venue: { label: string; lat: number; lng: number };
  readonly previousRules: SessionRules;
  readonly appliedRules: SessionRules;
  private readonly rand = seeded(29);
  private readonly pipeline: SensorPipeline;
  private readonly rawLines: string[] = [];
  /** The timeline's clock: a manual time while the history is written, then the server's clock. */
  private manual: number | null;
  private now: () => number = () => Date.now();
  private readonly clock: Clock;
  private cursor: number;

  private phaseValue: DemoPhase = "before_impact";
  private stoppedReason: string | null = null;
  private detections: TimelineEvent[] = [];
  private lastFix: TimelineEvent | null = null;
  private checkIn: { id: string; dueAt: Date; promptedEventId: string; status: CheckInDoc["status"] } | null = null;
  private missedEventId: string | null = null;
  private answeredEventId: string | null = null;
  private incident: { id: string; escalationId: string; openedEventId: string } | null = null;
  private readonly mirroredSteps = new Set<number>();
  private readonly mirroredJobs = new Map<string, "sent" | "delivered" | "failed">();
  private firstAlertEventId: string | null = null;
  private acknowledged = false;
  /** How many of the incident's "I'm OK" log lines are already in the record. */
  private updatesMirrored = 0;
  private resolved = false;
  private call: { id: string; status: "ringing" | "active" | "ended" } | null = null;
  private consentScopes = new Set<ConsentScope>();

  constructor(
    session: SessionDoc,
    subject: ParticipantDoc,
    startedAt: number,
    private readonly calls: CallService,
    previousRules: SessionRules,
    appliedRules: SessionRules,
  ) {
    this.sessionId = session._id;
    this.subject = subject;
    this.hostParticipantId = session.participants.find((p) => p.role === "host")?.participantId ?? null;
    this.startedAt = startedAt;
    this.previousRules = previousRules;
    this.appliedRules = appliedRules;
    this.impactAt = Math.ceil((startedAt + LEAD_MS + 2_000) / WINDOW_MS) * WINDOW_MS - 2_000;
    this.historyStart = Math.floor((startedAt - HISTORY_MS) / WINDOW_MS) * WINDOW_MS;
    this.venue = session.rules.demoVenue ?? FALLBACK_VENUE;
    this.manual = this.historyStart;
    this.clock = { now: () => this.manual ?? this.now() };
    this.cursor = this.historyStart;
    this.timeline = new Timeline({ sessionId: session._id, clock: this.clock });
    this.pipeline = new SensorPipeline({
      timeline: this.timeline,
      clock: this.clock,
      participantId: subject.participantId,
      recordingId: `rec_${newId("con").slice(4)}`,
      source: { sensor: "accelerometer", deviceKind: "synthetic", deviceModel: null, sensorName: "synthetic accelerometer", dataOrigin: "synthetic_scenario", scenarioId: SCENARIO },
      rawWrite: (line) => this.rawLines.push(line),
      features: { nominalRateHz: RATE_HZ, sensorRangeM_s2: SENSOR_RANGE, windowMs: WINDOW_MS },
    });
    this.writeHistory(session);
    this.consentScopes = new Set(this.scopes(subject));
    this.manual = null;
  }

  get phase(): DemoPhase {
    return this.phaseValue;
  }

  get finished(): boolean {
    return FINISHED.has(this.phaseValue);
  }

  /** Raw sample batches, kept apart from the derived timeline (CLAUDE.md). */
  get rawRecording(): readonly string[] {
    return this.rawLines;
  }

  view(): DemoView {
    return {
      sessionId: this.sessionId,
      participantId: this.subject.participantId,
      name: this.subject.displayName,
      phase: this.phaseValue,
      startedAt: toIso(this.startedAt),
      impactAt: toIso(this.impactAt),
      checkIn: this.checkIn ? { id: this.checkIn.id, dueAt: this.checkIn.dueAt.toISOString(), status: this.checkIn.status } : null,
      incidentId: this.incident?.id ?? null,
      call: this.call,
      timelineEvents: this.timeline.length,
      rules: DEMO_RULES,
      stoppedReason: this.stoppedReason,
    };
  }

  stop(reason: string): void {
    if (this.finished) return;
    this.stoppedReason = reason;
    this.phaseValue = "stopped";
    if (this.call?.status === "ringing") {
      this.calls.end(this.call.id);
      this.call = { ...this.call, status: "ended" };
    }
  }

  /** One pass: feed samples up to now, then mirror whatever the server decided. */
  async step(deps: Deps): Promise<void> {
    this.now = () => deps.now().getTime();
    const session = await deps.store.getSession(this.sessionId);
    const subject = session?.participants.find((p) => p.participantId === this.subject.participantId);
    if (!session || !subject || subject.leftAt !== null) return this.stop(`${this.subject.displayName} left, or the session is gone.`);
    this.subject = subject;
    this.syncConsent(subject);
    if (session.status === "ended" && !this.incident) return this.stop("The session ended.");

    const now = deps.now().getTime();
    if (!this.incident && session.suspendedAt) {
      this.cursor = Math.max(this.cursor, now);
      return;
    }
    if (!this.resolved) this.feed(now);
    if (!this.checkIn) {
      if (now >= this.impactAt && this.phaseValue === "before_impact") this.phaseValue = "watching";
      const found = this.detections.filter((e) => Date.parse(e.occurred_at) > this.impactAt);
      if (found.length > 0) await this.promptCheckIn(deps, session, subject, found, now);
      return;
    }
    await this.mirrorCheckIn(deps);
    if (this.finished) return;
    await this.mirrorIncident(deps, session);
  }

  private syncConsent(subject: ParticipantDoc): void {
    const next = new Set(this.scopes(subject));
    const revoked = [...this.consentScopes].filter((scope) => !next.has(scope));
    const granted = [...next].filter((scope) => !this.consentScopes.has(scope));
    if (revoked.length > 0) {
      this.timeline.append({
        type: "consent.revoked",
        participant_id: subject.participantId,
        actor: { kind: "participant", id: subject.participantId },
        provenance: prov("ui"),
        data: { scopes: revoked },
      });
    }
    if (granted.length > 0) {
      this.timeline.append({
        type: "consent.granted",
        participant_id: subject.participantId,
        actor: { kind: "participant", id: subject.participantId },
        provenance: prov("ui"),
        data: { scopes: granted, consent_text_version: subject.consentTextVersion },
      });
    }
    this.consentScopes = next;
  }

  // ── Inputs: synthetic samples through the real pipeline ──────────────

  /** What the phone experiences at time t. null: no samples. */
  private segment(t: number): Segment | null {
    const pocket = ORIENTATION.inPocket;
    const m = (t - this.historyStart) / MINUTE;
    if (t > this.impactAt + 200) {
      return t < this.impactAt + STILL_FOR_MS ? { motion: { kind: "still" }, gravity: ORIENTATION.flat } : null;
    }
    if (m < 10) return { motion: { kind: "rhythmic", hz: 1.8, amplitude: 2 }, gravity: pocket };
    if (m < 35) return { motion: { kind: "fidget", amplitude: 0.4 }, gravity: pocket };
    if (m < 42) return { motion: { kind: "still" }, gravity: ORIENTATION.flat };
    if (m < 75) return { motion: { kind: "rhythmic", hz: 2.3, amplitude: 4, jitter: 0.05 }, gravity: pocket };
    if (m < 86) return { motion: { kind: "fidget", amplitude: 0.6 }, gravity: pocket };
    return { motion: { kind: "rhythmic", hz: 1.8, amplitude: 2 }, gravity: pocket };
  }

  private samples(from: number, to: number): Sample[] {
    const seg = this.segment(from);
    if (!seg || to - from < 1000 / RATE_HZ) return [];
    const samples = synthesize({ start: from, durationMs: to - from, rateHz: RATE_HZ, gravity: seg.gravity, motion: seg.motion, rand: this.rand, timingJitterMs: 1 });
    if (from <= this.impactAt && this.impactAt < to) {
      // A hard jolt that saturates the sensor, then the phone lies flat.
      for (const s of samples) {
        if (s.t < this.impactAt + 200) continue;
        s.x = ORIENTATION.flat[0] + (this.rand() - 0.5) * 0.02;
        s.y = ORIENTATION.flat[1] + (this.rand() - 0.5) * 0.02;
        s.z = ORIENTATION.flat[2] + (this.rand() - 0.5) * 0.02;
      }
      addImpact(samples, this.impactAt, 190, ORIENTATION.inPocket);
      for (const s of samples) {
        s.x = clamp(s.x);
        s.y = clamp(s.y);
        s.z = clamp(s.z);
      }
    }
    return samples.filter((s) => s.t >= from && s.t < to);
  }

  /** Feeds samples from the cursor to `to`, split at window, segment and impact boundaries. */
  private feed(to: number): void {
    while (this.cursor < to) {
      const nextWindow = (Math.floor(this.cursor / WINDOW_MS) + 1) * WINDOW_MS;
      const cuts = [to, nextWindow, this.historyStart + 10 * MINUTE, this.historyStart + 35 * MINUTE, this.historyStart + 42 * MINUTE, this.historyStart + 75 * MINUTE, this.historyStart + 86 * MINUTE, this.impactAt + 201];
      const end = Math.min(...cuts.filter((c) => c > this.cursor));
      const batch = this.samples(this.cursor, end);
      // While writing history, let each window close; never past the trigger, so recorded times stay in order.
      if (this.manual !== null) this.manual = Math.max(this.manual, Math.min(end + 2_000, this.startedAt));
      this.detections.push(...this.pipeline.ingest(batch), ...this.pipeline.tick());
      this.cursor = end;
    }
    this.detections.push(...this.pipeline.tick());
  }

  /** History only: runs the pipeline up to t and moves the timeline's clock there. */
  private advanceTo(t: number): void {
    this.feed(t);
    this.manual = Math.max(this.manual ?? t, Math.min(t, this.startedAt));
  }

  // ── The synthetic evening, written once at the trigger ───────────────

  private writeHistory(session: SessionDoc): void {
    const S = this.historyStart;
    const host = this.hostParticipantId;
    const sub = this.subject;
    const policy = DEMO_RULES;
    this.timeline.append({
      type: "session.created",
      participant_id: host,
      actor: host ? { kind: "host", id: host } : { kind: "scenario_script", id: null },
      provenance: prov("session_manager"),
      data: {
        expires_at: session.expiresAt.toISOString(),
        checkin_response_window_ms: policy.checkInWindowSec * 1000,
        escalation_steps: [
          ...(sub.role !== "host" ? [{ step: 1, target_role: "host" as const, ack_window_ms: policy.hostAckWindowSec * 1000, max_repeats: 0 }] : []),
          ...(sub.backupContacts.length > 0 ? [{ step: 0, target_role: "backup_contact" as const, ack_window_ms: policy.backupAckWindowSec * 1000, max_repeats: 0 }] : []),
          { step: 0, target_role: "emergency_service_sim" as const, ack_window_ms: 0, max_repeats: 0 },
        ].map((s, i) => ({ ...s, step: i + 1 })),
        thresholds_validated: false,
      },
    });
    if (host && host !== sub.participantId) {
      this.join(host, "host", "host_created", ["monitoring"]);
    }
    this.join(sub.participantId, sub.role === "host" ? "host" : "member", sub.role === "host" ? "host_created" : "qr_code", this.scopes(sub));
    if (sub.consent.shareNoteWithResponders) {
      this.timeline.append({
        type: "profile.shared",
        participant_id: sub.participantId,
        actor: { kind: "participant", id: sub.participantId },
        provenance: prov("ui"),
        data: { display_name: sub.displayName.slice(0, 64), ...(sub.responderNote ? { emergency_notes: sub.responderNote.slice(0, 500) } : {}) },
      });
    }
    this.pipeline.start();

    this.fix(S + 30_000, 10, 1.4, 120, "entrance");
    this.fix(S + 15 * MINUTE, -15, 0, null, "main room");

    // Phone left on a table: the detector notices, a private check-in goes out, answered OK.
    this.advanceTo(S + 42 * MINUTE);
    const table = this.detections.find(
      (e) => e.type === "sensor.motion_anomaly_observed" && Date.parse(e.occurred_at) >= S + 35 * MINUTE && Date.parse(e.occurred_at) <= S + 42 * MINUTE,
    );
    if (table) {
      const at = Date.parse(table.occurred_at) + 2_000;
      const id = `chk_demo-${sub.participantId.slice(4, 12)}`;
      const prompted = this.timeline.append({
        type: "checkin.prompted",
        participant_id: sub.participantId,
        actor: { kind: "system", id: null },
        provenance: prov("incident_manager"),
        caused_by: [table.event_id],
        occurred_at: at,
        data: { checkin_id: id, trigger: "motion_anomaly", delivery: "notification", response_deadline_at: toIso(at + policy.checkInWindowSec * 1000) },
      });
      this.timeline.append({
        type: "checkin.responded",
        participant_id: sub.participantId,
        actor: { kind: "participant", id: sub.participantId },
        provenance: prov("ui"),
        caused_by: [prompted.event_id],
        occurred_at: at + 9_000,
        data: { checkin_id: id, response: "confirmed_ok", method: "tap", latency_ms: 9_000 },
      });
    }

    this.fix(S + 50 * MINUTE, 25, 0.2, null, "dance floor");
    this.fix(S + 80 * MINUTE, -30, 0, null, "bar");
    this.fix(S + 87 * MINUTE, -10, 1.3, 80);
    // Up to the trigger: walking toward the exit. The impact comes live.
    this.advanceTo(Math.max(S + 87 * MINUTE, this.startedAt - 3_000));
    this.fix(this.startedAt - 3_000, 35, 1.2, 95, "rear exit");
    this.advanceTo(this.startedAt);
  }

  /** The consent the person gave for themself, as timeline scopes. */
  private scopes(p: ParticipantDoc): ConsentScope[] {
    const scopes: ConsentScope[] = [];
    if (p.consent.monitoring) scopes.push("monitoring");
    if (p.consent.locationSharing === "group") scopes.push("location.group");
    if (p.consent.shareLocationWithResponders) scopes.push("location.responders");
    if (p.consent.shareNoteWithResponders) scopes.push("profile.responders");
    return scopes;
  }

  private join(id: string, role: "host" | "member", via: "host_created" | "qr_code", scopes: ConsentScope[]): void {
    const actor = { kind: role === "host" ? ("host" as const) : ("participant" as const), id };
    this.timeline.append({ type: "session.participant_joined", participant_id: id, actor, provenance: prov("session_manager"), data: { role, joined_via: via } });
    if (scopes.length > 0) {
      this.timeline.append({ type: "consent.granted", participant_id: id, actor, provenance: prov("ui"), data: { scopes, consent_text_version: "consent-v0.1" } });
    }
  }

  /** A synthetic position around the demo venue (a public place), recorded only if they share location. */
  private fix(t: number, metres: number, speed: number, heading: number | null, place?: string): void {
    this.advanceTo(t);
    const id = this.subject.participantId;
    if (!this.timeline.hasConsent(id, "location.group") && !this.timeline.hasConsent(id, "location.responders")) return;
    const M_PER_DEG = 111_320;
    this.lastFix = this.timeline.append({
      type: "location.reported",
      participant_id: id,
      actor: { kind: "participant", id },
      provenance: prov("sensor_adapter", true),
      occurred_at: t,
      data: {
        latitude: round6(this.venue.lat + metres / M_PER_DEG),
        longitude: round6(this.venue.lng + metres / (M_PER_DEG * Math.cos((this.venue.lat * Math.PI) / 180))),
        accuracy_m: 12,
        fix_at: toIso(t),
        source: "synthetic",
        speed_m_s: speed,
        heading_deg: heading,
        ...(place ? { place_label: `${this.venue.label}, ${place} (simulated)`.slice(0, 120) } : {}),
      },
    });
  }

  // ── Server state, mirrored into the record ───────────────────────────

  /** The detector fired after the impact: the server starts the private check-in, as the phone's request would. */
  private async promptCheckIn(deps: Deps, session: SessionDoc, subject: ParticipantDoc, found: TimelineEvent[], now: number): Promise<void> {
    if (!subject.consent.monitoring) return this.stop(`${subject.displayName} turned movement check-ins off.`);
    if (await deps.store.findActiveIncident(session._id, subject.participantId)) return this.stop("An alert about them was opened another way.");
    const at = new Date(now);
    const doc: CheckInDoc = {
      _id: newId("chk"),
      sessionId: session._id,
      participantId: subject.participantId,
      reason: "movement_changed",
      observationEventId: found[0]!.event_id,
      promptedAt: at,
      dueAt: new Date(now + session.rules.checkInWindowSec * 1000),
      status: "pending",
      respondedAt: null,
      cancelledReason: null,
      incidentId: null,
    };
    await deps.store.insertCheckIn(doc);
    const prompted = this.timeline.append({
      type: "checkin.prompted",
      participant_id: subject.participantId,
      actor: { kind: "system", id: null },
      provenance: prov("incident_manager"),
      caused_by: found.map((e) => e.event_id),
      data: { checkin_id: doc._id, trigger: found.some((e) => e.type === "sensor.motion_pattern_observed") ? "motion_pattern" : "motion_anomaly", delivery: "notification", response_deadline_at: doc.dueAt.toISOString() },
    });
    this.checkIn = { id: doc._id, dueAt: doc.dueAt, promptedEventId: prompted.event_id, status: "pending" };
    this.phaseValue = "checkin_pending";
  }

  private async mirrorCheckIn(deps: Deps): Promise<void> {
    const c = this.checkIn!;
    const doc = await deps.store.getCheckIn(c.id);
    if (!doc || doc.status === c.status) return;
    c.status = doc.status;
    const sub = this.subject.participantId;
    if (doc.status === "responded_ok" || doc.status === "requested_help") {
      const answered = this.timeline.append({
        type: "checkin.responded",
        participant_id: sub,
        actor: { kind: "participant", id: sub },
        provenance: prov("ui"),
        caused_by: [c.promptedEventId],
        occurred_at: (doc.respondedAt ?? deps.now()).getTime(),
        data: {
          checkin_id: c.id,
          response: doc.status === "responded_ok" ? "confirmed_ok" : "requested_help",
          method: "tap",
          latency_ms: Math.max(0, (doc.respondedAt ?? deps.now()).getTime() - doc.promptedAt.getTime()),
        },
      });
      this.answeredEventId = answered.event_id;
      if (doc.status === "responded_ok") this.phaseValue = "answered_ok";
    } else if (doc.status === "missed") {
      const missed = this.timeline.append({
        type: "checkin.missed",
        participant_id: sub,
        actor: { kind: "scheduler", id: null },
        provenance: prov("escalation_scheduler"),
        caused_by: [c.promptedEventId],
        occurred_at: Math.min(doc.dueAt.getTime(), deps.now().getTime()),
        data: { checkin_id: c.id, response_deadline_at: doc.dueAt.toISOString() },
      });
      this.missedEventId = missed.event_id;
    } else if (doc.status === "cancelled") {
      this.stop("The check-in was cancelled (they left, or the session ended).");
    }
  }

  private async mirrorIncident(deps: Deps, session: SessionDoc): Promise<void> {
    const sub = this.subject.participantId;
    let doc: IncidentDoc | null = null;
    if (this.incident) doc = await deps.store.getIncident(this.incident.id);
    else {
      const checkIn = await deps.store.getCheckIn(this.checkIn!.id);
      doc = checkIn?.incidentId ? await deps.store.getIncident(checkIn.incidentId) : null;
      const trigger = doc?.trigger === "help_requested" ? this.answeredEventId : this.missedEventId;
      if (!doc || !trigger) return;
      const opened = this.timeline.append({
        type: "incident.opened",
        incident_id: doc._id,
        participant_id: sub,
        actor: { kind: "system", id: null },
        provenance: prov("incident_manager"),
        caused_by: [trigger],
        occurred_at: Math.min(doc.openedAt.getTime(), deps.now().getTime()),
        data: { trigger: doc.trigger, trigger_event_id: trigger },
      });
      this.incident = { id: doc._id, escalationId: `esc_${doc._id.slice(4)}`, openedEventId: opened.event_id };
      this.phaseValue = "incident_open";
      await deps.store.appendIncidentLog(doc._id, {
        at: doc.openedAt,
        kind: "checkin",
        text: "Why the check-in was sent (simulated sensor input): a hard impact on their phone, then no movement. An observation, not a diagnosis.",
        simulated: true,
      });
    }
    if (!doc) return;
    const inc = this.incident!;
    const scope = { incident_id: inc.id, participant_id: sub };
    const jobs = await deps.store.listJobsForIncident(inc.id);
    const delivered = [...this.detections.filter((e) => Date.parse(e.occurred_at) > this.impactAt).map((e) => e.event_id), this.missedEventId, this.lastFix?.event_id].filter(
      (x): x is string => !!x,
    );

    // Steps the server notified, in order: fired (after the first), alerts sent, next deadline set.
    for (const [i, step] of doc.steps.entries()) {
      if (!step.notifiedAt || this.mirroredSteps.has(i)) continue;
      this.mirroredSteps.add(i);
      const at = Math.min(step.notifiedAt.getTime(), deps.now().getTime());
      const role = step.level === "host" ? "host" : step.level === "backup" ? "backup_contact" : "emergency_service_sim";
      let basis: TimelineEvent = this.timeline.getEvent(inc.openedEventId)!;
      if (i > 0) {
        basis = this.timeline.append({
          ...scope,
          type: "escalation.step_fired",
          actor: { kind: "scheduler", id: null },
          provenance: prov("escalation_scheduler"),
          occurred_at: at,
          data: { escalation_id: inc.escalationId, step: i + 1, target_role: role, scheduled_due_at: (step.dueAt ?? step.notifiedAt).toISOString(), fired_late_ms: Math.max(0, at - (step.dueAt ?? step.notifiedAt).getTime()) },
        });
      }
      if (step.level === "emergency_simulated") {
        this.timeline.append({
          ...scope,
          type: "emergency.simulated_dispatch_requested",
          actor: { kind: "system", id: null },
          provenance: prov("transport_sim", true),
          caused_by: [basis.event_id],
          occurred_at: at,
          data: { mock_endpoint_id: MOCK_OPERATOR_ENDPOINT_ID, escalation_id: inc.escalationId, delivered_fact_event_ids: delivered },
        });
        await this.placeCall(deps, inc.id, step.notifiedAt, session);
        continue;
      }
      let firstSent: TimelineEvent | null = null;
      for (const job of jobs.filter((j) => j.stepIndex === i)) {
        const recipient = recipientId(job, session);
        const sent = this.timeline.append({
          ...scope,
          type: "notification.sent",
          actor: { kind: "transport_sim", id: null },
          provenance: prov("transport_sim", true),
          caused_by: [basis.event_id],
          occurred_at: at,
          data: { notification_id: job._id, recipient_id: recipient, recipient_role: role, channel: role === "host" ? "in_app_sim" : "push_sim", escalation_step: i + 1, attempt: 1, is_repeat: false, delivered_fact_event_ids: delivered },
        });
        firstSent ??= sent;
        this.firstAlertEventId ??= sent.event_id;
        this.mirroredJobs.set(job._id, "sent");
      }
      const next = doc.steps[i + 1];
      if (next?.dueAt) {
        this.timeline.append({
          ...scope,
          type: "escalation.step_scheduled",
          actor: { kind: "scheduler", id: null },
          provenance: prov("escalation_scheduler"),
          caused_by: [(firstSent ?? basis).event_id],
          occurred_at: at,
          data: {
            escalation_id: inc.escalationId,
            step: i + 2,
            target_role: next.level === "backup" ? "backup_contact" : next.level === "host" ? "host" : "emergency_service_sim",
            due_at: next.dueAt.toISOString(),
            deadline_basis_event_id: (firstSent ?? basis).event_id,
          },
        });
      }
    }

    // Delivery results from the simulated transport.
    for (const job of jobs) {
      const seen = this.mirroredJobs.get(job._id);
      if (seen !== "sent") continue;
      const recipient = recipientId(job, session);
      if (job.deliveredAt) {
        this.timeline.append({ ...scope, type: "notification.delivered", actor: { kind: "transport_sim", id: null }, provenance: prov("transport_sim", true), occurred_at: Math.min(job.deliveredAt.getTime(), deps.now().getTime()), data: { notification_id: job._id, recipient_id: recipient } });
        this.mirroredJobs.set(job._id, "delivered");
      } else if (job.status === "failed") {
        this.timeline.append({ ...scope, type: "notification.delivery_failed", actor: { kind: "transport_sim", id: null }, provenance: prov("transport_sim", true), data: { notification_id: job._id, recipient_id: recipient, reason: "transport_error", will_retry: false } });
        this.mirroredJobs.set(job._id, "failed");
      }
    }

    // "Tell responders I'm OK" from their phone: their own report, in the record the agent reads.
    const updates = doc.log.filter((l) => l.kind === "participant_update");
    for (const u of updates.slice(this.updatesMirrored)) {
      this.timeline.append({
        ...scope,
        type: "incident.participant_update",
        actor: { kind: "participant", id: sub },
        provenance: prov("ui"),
        occurred_at: Math.min(u.at.getTime(), deps.now().getTime()),
        data: { update: "reported_ok", method: "tap" },
      });
    }
    this.updatesMirrored = updates.length;

    if (doc.acknowledged && !this.acknowledged) {
      this.acknowledged = true;
      const by = session.participants.find((p) => p.userId === doc!.acknowledged!.byUserId);
      const job = jobs.find((j) => j.recipient.kind === "user" && j.recipient.userId === doc!.acknowledged!.byUserId) ?? jobs[0];
      if (job) {
        this.timeline.append({
          ...scope,
          type: "incident.acknowledged",
          actor: { kind: "host", id: by?.participantId ?? null },
          provenance: prov("ui"),
          occurred_at: Math.min(doc.acknowledged.at.getTime(), deps.now().getTime()),
          data: { acknowledged_by_role: "host", acknowledged_by_id: by?.participantId ?? "host", notification_id: job._id },
        });
      }
      const pending = doc.steps.findIndex((s) => !s.notifiedAt);
      if (pending >= 0) {
        this.timeline.append({
          ...scope,
          type: "escalation.step_cancelled",
          actor: { kind: "scheduler", id: null },
          provenance: prov("escalation_scheduler"),
          data: { escalation_id: inc.escalationId, step: pending + 1, reason: "acknowledged" },
        });
      }
      if (this.phaseValue !== "on_call") this.phaseValue = "acknowledged";
    }

    if (doc.resolved && !this.resolved) {
      this.resolved = true;
      const by = session.participants.find((p) => p.userId === doc!.resolved!.byUserId);
      this.timeline.append({
        ...scope,
        type: "incident.resolved",
        actor: { kind: "host", id: by?.participantId ?? null },
        provenance: prov("ui"),
        occurred_at: Math.min(doc.resolved.at.getTime(), deps.now().getTime()),
        data: {
          resolution: doc.resolved.outcome === "assistance_reached" ? "assistance_reached_participant" : doc.resolved.outcome,
          resolved_by_role: "host",
          resolved_by_id: by?.participantId ?? "host",
        },
      });
    }

    await this.followCall(deps, inc.id);
    if (this.resolved && this.call?.status !== "active") this.phaseValue = "resolved";
  }

  // ── The simulated call ───────────────────────────────────────────────

  private async placeCall(deps: Deps, incidentId: string, at: Date, session: SessionDoc): Promise<void> {
    if (this.call) return;
    const shared = this.timeline.hasConsent(this.subject.participantId, "profile.responders");
    const id = this.calls.ring({
      timeline: this.timeline,
      clock: this.clock,
      incidentId,
      sessionId: session._id,
      about: shared ? this.subject.displayName : "a participant who did not share their name",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      scenarioId: SCENARIO,
    });
    this.call = { id, status: "ringing" };
    this.phaseValue = "calling";
    await deps.store.appendIncidentLog(incidentId, {
      at,
      kind: "escalation",
      text: "The YTC voice agent is calling the simulated emergency operator. No real call is placed.",
      simulated: true,
    });
  }

  /** Logs the call's outcome in the incident's record as it changes. */
  private async followCall(deps: Deps, incidentId: string): Promise<void> {
    if (!this.call) return;
    const status = this.calls.status(this.call.id) ?? "ended";
    if (status === this.call.status) return;
    this.call = { ...this.call, status };
    const at = deps.now();
    if (status === "active") {
      this.phaseValue = "on_call";
      await deps.store.appendIncidentLog(incidentId, { at, kind: "escalation", text: "The simulated operator answered. The agent is reading the incident record.", simulated: true });
    } else if (status === "ended") {
      if (this.phaseValue === "on_call" || this.phaseValue === "calling") this.phaseValue = this.resolved ? "resolved" : this.acknowledged ? "acknowledged" : "incident_open";
      await deps.store.appendIncidentLog(incidentId, { at, kind: "escalation", text: "The simulated call ended. The alert stays open until a responder resolves it.", simulated: true });
    }
  }
}

const clamp = (v: number) => Math.max(-SENSOR_RANGE, Math.min(SENSOR_RANGE, v));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The timeline's id for an alert's recipient: a participant id, or a backup contact's con_ id. */
function recipientId(job: NotificationJobDoc, session: SessionDoc): string {
  const r = job.recipient;
  if (r.kind === "backup_contact") return r.contactId;
  if (r.kind === "user") return session.participants.find((p) => p.userId === r.userId)?.participantId ?? "host";
  return MOCK_OPERATOR_ENDPOINT_ID;
}

function sameRules(a: SessionRules, b: SessionRules): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
