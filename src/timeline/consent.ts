/**
 * Current consent per participant, replayed from timeline events. The
 * timeline uses it to refuse sensor/location data nobody agreed to record;
 * the briefing uses it to decide what responders may see.
 */
import type { ConsentScope } from "./schema/envelope.js";
import type { TimelineEvent } from "./schema/catalog.js";

export class ConsentLedger {
  private readonly scopes = new Map<string, Set<ConsentScope>>();

  static from(events: readonly TimelineEvent[]): ConsentLedger {
    const ledger = new ConsentLedger();
    for (const e of events) ledger.apply(e);
    return ledger;
  }

  apply(event: TimelineEvent): void {
    const id = event.participant_id;
    if (!id) return;
    if (event.type === "consent.granted") {
      const set = this.scopes.get(id) ?? new Set();
      event.data.scopes.forEach((s) => set.add(s));
      this.scopes.set(id, set);
    } else if (event.type === "consent.revoked") {
      event.data.scopes.forEach((s) => this.scopes.get(id)?.delete(s));
    } else if (event.type === "session.participant_left") {
      // Leaving withdraws everything; rejoining requires consenting again.
      this.scopes.delete(id);
    }
  }

  has(participantId: string, scope: ConsentScope): boolean {
    return this.scopes.get(participantId)?.has(scope) ?? false;
  }

  hasAny(participantId: string, scopes: readonly ConsentScope[]): boolean {
    return scopes.some((s) => this.has(participantId, s));
  }

  scopesOf(participantId: string): ConsentScope[] {
    return [...(this.scopes.get(participantId) ?? [])];
  }
}
