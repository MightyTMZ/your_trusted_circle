/**
 * The server's own record of each session: an append-only, hash-chained
 * timeline in the src/timeline catalog format, stored in `timeline_events`.
 *
 * Everything the server decides (sessions, consent, check-ins, incidents,
 * alerts, escalation, acknowledgment, the simulated emergency step, voice
 * call turns) is appended here, so the voice agent's briefing and the
 * Incident Card are built from what actually happened (CLAUDE.md). Client
 * motion and profile events are copied in too (lifecycle/events.ts).
 *
 * Each append re-checks the event against the catalog and the chain. Two
 * writers racing for the same position: one insert wins on the unique
 * (session_id, seq) index, the other reloads and tries again.
 */
import { randomIds, type IdGenerator } from "../../shared/ids.js";
import type { Component, DataOrigin, Provenance } from "../../timeline/schema/envelope.js";
import type { EventType, TimelineEvent } from "../../timeline/schema/catalog.js";
import { Timeline, TimelineError, type EventDraft } from "../../timeline/timeline.js";
import type { Store } from "../store/store.js";

export const SERVER_PRODUCER = "ytc-api@1";

export function prov(component: Component, opts: { simulated?: boolean; origin?: DataOrigin } = {}): Provenance {
  return { component, data_origin: opts.origin ?? "system_generated", simulated: opts.simulated ?? false, producer: SERVER_PRODUCER };
}

export class SessionTimelines {
  private readonly cache = new Map<string, Timeline>();
  private readonly clock = { now: () => this.now().getTime() };

  /**
   * strict: throw when the server tries to record an event the catalog
   * refuses (tests). Otherwise log the event type and refuse quietly, so a
   * recording bug never blocks an alert.
   */
  constructor(
    private readonly store: Store,
    private readonly now: () => Date,
    private readonly strict = false,
  ) {}

  private async load(sessionId: string): Promise<Timeline> {
    const cached = this.cache.get(sessionId);
    if (cached && cached.length === (await this.store.countTimelineEvents(sessionId))) return cached;
    const restored = Timeline.restore(await this.store.listTimelineEvents(sessionId), { sessionId, clock: this.clock, ids: randomIds });
    this.cache.set(sessionId, restored);
    return restored;
  }

  async events(sessionId: string): Promise<readonly TimelineEvent[]> {
    return (await this.load(sessionId)).events;
  }

  async append<T extends EventType>(sessionId: string, draft: EventDraft<T>): Promise<TimelineEvent<T> | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const timeline = await this.load(sessionId);
      let event: TimelineEvent<T>;
      try {
        event = timeline.append(draft);
      } catch (err) {
        if (!(err instanceof TimelineError)) throw err;
        this.cache.delete(sessionId);
        if (this.strict) throw err;
        console.warn(`[timeline] refused ${draft.type}: ${err.issues.map((i) => i.path).join(", ")}`);
        return null;
      }
      if (await this.store.insertTimelineEvent(event)) return event;
      // Another writer took this position; reload and append after it.
      this.cache.delete(sessionId);
    }
    console.warn(`[timeline] gave up appending ${draft.type} after repeated conflicts`);
    return null;
  }

  /**
   * Rebuilds a session's chain without some events (account deletion).
   * Original ids and times are kept, links to removed events are dropped,
   * and every remaining event is re-validated and re-hashed.
   */
  async reseal(sessionId: string, keep: (e: TimelineEvent) => boolean): Promise<number> {
    const original = await this.store.listTimelineEvents(sessionId);
    const kept = original.filter(keep);
    if (kept.length === original.length) return 0;
    const keptIds = new Set(kept.map((e) => e.event_id));
    let current = kept[0];
    const ids: IdGenerator = { next: () => current!.event_id };
    const rebuilt = new Timeline({ sessionId, clock: { now: () => Date.parse(current!.recorded_at) }, ids });
    for (const e of kept) {
      current = e;
      try {
        rebuilt.append({
          type: e.type,
          data: e.data as never,
          actor: e.actor,
          provenance: e.provenance,
          incident_id: e.incident_id,
          participant_id: e.participant_id,
          occurred_at: e.occurred_at,
          caused_by: e.caused_by.filter((id) => keptIds.has(id)),
        });
      } catch {
        // An event that only made sense with removed ones (e.g. an incident about the deleted person) goes too.
        keptIds.delete(e.event_id);
      }
    }
    await this.store.replaceTimeline(sessionId, [...rebuilt.events]);
    this.cache.delete(sessionId);
    return original.length - rebuilt.length;
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
