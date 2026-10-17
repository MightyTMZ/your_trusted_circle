/**
 * Append-only, hash-chained event log for one session. The timeline checks
 * integrity (schema, ordering, references, chain); business rules such as
 * when to escalate belong to the session/incident state machines.
 */
import { parseIso, toIso, type Clock } from "../shared/clock.js";
import { randomIds, type IdGenerator } from "../shared/ids.js";
import { hashEvent, serializeEvent } from "./canonical.js";
import type { Issue } from "./schema/validate.js";
import { SCHEMA_VERSION, type Actor, type ConsentScope, type Provenance } from "./schema/envelope.js";
import {
  categoryOf,
  checkEvent,
  checkTypedFields,
  renderSummary,
  specFor,
  type EventType,
  type PayloadOf,
  type TimelineEvent,
} from "./schema/catalog.js";
import type { TimelineSink } from "./sinks.js";
import { ConsentLedger } from "./consent.js";

export interface EventDraft<T extends EventType> {
  type: T;
  data: PayloadOf<T>;
  actor: Actor;
  provenance: Provenance;
  incident_id?: string | null;
  participant_id?: string | null;
  /** When it happened: epoch ms or ISO string. Defaults to the clock's now. */
  occurred_at?: number | string;
  caused_by?: string[];
}

export interface TimelineOptions {
  sessionId: string;
  clock: Clock;
  ids?: IdGenerator;
  sinks?: TimelineSink[];
  /** How far occurred_at may be ahead of the clock (device clock skew). Default 2000 ms. */
  maxFutureSkewMs?: number;
}

export class TimelineError extends Error {
  constructor(
    message: string,
    readonly issues: Issue[],
  ) {
    super(`${message}: ${issues.map((i) => `${i.path || "(event)"} ${i.message}`).join("; ")}`);
    this.name = "TimelineError";
  }
}

export class Timeline {
  readonly sessionId: string;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly sinks: TimelineSink[];
  private readonly maxFutureSkewMs: number;

  private readonly log: TimelineEvent[] = [];
  private readonly byId = new Map<string, TimelineEvent>();
  private readonly incidents = new Set<string>();
  private readonly consent = new ConsentLedger();

  constructor(opts: TimelineOptions) {
    this.sessionId = opts.sessionId;
    this.clock = opts.clock;
    this.ids = opts.ids ?? randomIds;
    this.sinks = opts.sinks ?? [];
    this.maxFutureSkewMs = opts.maxFutureSkewMs ?? 2000;
  }

  /**
   * Rebuilds a timeline from stored events, re-verifying every event and
   * the hash chain. Sinks passed in opts receive only new appends.
   */
  static restore(events: readonly unknown[], opts: TimelineOptions): Timeline {
    const timeline = new Timeline(opts);
    events.forEach((raw, index) => {
      const issues = checkEvent(raw);
      if (issues.length === 0) {
        const event = raw as TimelineEvent;
        if (event.hash !== hashEvent(event)) issues.push({ path: "hash", message: "does not match event content" });
        issues.push(...timeline.checkContext(event));
      }
      if (issues.length > 0) throw new TimelineError(`Stored event #${index + 1} is invalid`, issues);
      timeline.commit(raw as TimelineEvent);
    });
    return timeline;
  }

  append<T extends EventType>(draft: EventDraft<T>): TimelineEvent<T> {
    const now = this.clock.now();
    const occurredMs = draft.occurred_at === undefined ? now : toMs(draft.occurred_at);
    const incident_id = draft.incident_id ?? null;
    const participant_id = draft.participant_id ?? null;

    const issues = checkTypedFields({ ...draft, incident_id, participant_id });
    if (occurredMs === null) issues.push({ path: "occurred_at", message: "invalid timestamp" });
    if (issues.length > 0) throw new TimelineError(`Rejected ${draft.type}`, issues);

    const previous = this.log.at(-1);
    const unhashed = {
      schema_version: SCHEMA_VERSION,
      event_id: this.ids.next("evt"),
      seq: this.log.length + 1,
      type: draft.type,
      category: categoryOf(draft.type),
      session_id: this.sessionId,
      incident_id,
      participant_id,
      occurred_at: toIso(occurredMs!),
      recorded_at: toIso(now),
      actor: draft.actor,
      provenance: draft.provenance,
      caused_by: [...(draft.caused_by ?? [])],
      data: draft.data,
      summary: renderSummary(draft.type, draft.data, { incident_id, participant_id }),
      prev_hash: previous?.hash ?? null,
    };
    // Built as the plain union; TypeScript cannot relate a generic T to it.
    const event = { ...unhashed, hash: hashEvent(unhashed) } as unknown as TimelineEvent;

    const contextIssues = this.checkContext(event);
    if (contextIssues.length > 0) throw new TimelineError(`Rejected ${draft.type}`, contextIssues);

    const frozen = deepFreeze(structuredClone(event));
    const line = serializeEvent(frozen);
    for (const sink of this.sinks) sink.write(frozen, line);
    this.commit(frozen);
    return frozen as TimelineEvent<T>;
  }

  get events(): readonly TimelineEvent[] {
    return this.log;
  }

  get length(): number {
    return this.log.length;
  }

  get headHash(): string | null {
    return this.log.at(-1)?.hash ?? null;
  }

  /** Whether the participant currently holds this consent scope. Producers check it before recording. */
  hasConsent(participantId: string, scope: ConsentScope): boolean {
    return this.consent.has(participantId, scope);
  }

  getEvent(eventId: string): TimelineEvent | undefined {
    return this.byId.get(eventId);
  }

  /** Incident IDs opened in this timeline, in order. */
  get incidentIds(): string[] {
    return [...this.incidents];
  }

  /** Ordering, chain and referential checks against what is already logged. */
  private checkContext(event: TimelineEvent): Issue[] {
    const issues: Issue[] = [];
    const previous = this.log.at(-1);

    if (event.session_id !== this.sessionId) {
      issues.push({ path: "session_id", message: `expected ${this.sessionId}` });
    }
    if (event.seq !== this.log.length + 1) {
      issues.push({ path: "seq", message: `expected ${this.log.length + 1}` });
    }
    if (event.prev_hash !== (previous?.hash ?? null)) {
      issues.push({ path: "prev_hash", message: "breaks the hash chain" });
    }
    if (this.byId.has(event.event_id)) {
      issues.push({ path: "event_id", message: "duplicate event_id" });
    }

    const recordedMs = parseIso(event.recorded_at)!;
    const occurredMs = parseIso(event.occurred_at)!;
    if (previous && recordedMs < parseIso(previous.recorded_at)!) {
      issues.push({ path: "recorded_at", message: "earlier than the previous event" });
    }
    if (occurredMs > recordedMs + this.maxFutureSkewMs) {
      issues.push({ path: "occurred_at", message: "is in the future relative to recorded_at" });
    }

    const seen = new Set<string>();
    for (const id of event.caused_by) {
      if (seen.has(id)) issues.push({ path: "caused_by", message: `duplicate ${id}` });
      else if (!this.byId.has(id)) issues.push({ path: "caused_by", message: `${id} is not an earlier event` });
      seen.add(id);
    }

    if (event.incident_id !== null) {
      const known = this.incidents.has(event.incident_id);
      if (event.type === "incident.opened" && known) {
        issues.push({ path: "incident_id", message: `${event.incident_id} is already open` });
      } else if (event.type !== "incident.opened" && !known) {
        issues.push({ path: "incident_id", message: `${event.incident_id} has not been opened` });
      }
    }
    if (event.type === "incident.opened" && !this.byId.has(event.data.trigger_event_id)) {
      issues.push({ path: "data.trigger_event_id", message: "is not an earlier event" });
    }

    const required = specFor(event.type).requiresConsent;
    if (required && event.participant_id && !this.consent.hasAny(event.participant_id, required)) {
      issues.push({
        path: "participant_id",
        message: `${event.participant_id} has not granted ${required.join(" or ")}; ${event.type} cannot be recorded`,
      });
    }
    return issues;
  }

  private commit(event: TimelineEvent): void {
    this.log.push(event);
    this.byId.set(event.event_id, event);
    this.consent.apply(event);
    if (event.type === "incident.opened" && event.incident_id) this.incidents.add(event.incident_id);
  }
}

function toMs(value: number | string): number | null {
  if (typeof value === "string") return parseIso(value);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
