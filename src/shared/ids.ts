import { randomUUID } from "node:crypto";

/**
 * Prefixes make IDs self-describing in logs and in the voice agent's
 * context ("inc_..." is obviously an incident). Add new prefixes here.
 */
export const ID_PREFIXES = {
  event: "evt",
  session: "ses",
  incident: "inc",
  participant: "par",
  contact: "con",
  checkin: "chk",
  notification: "ntf",
  escalation: "esc",
  call: "call",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

/** Deterministic IDs for tests and fixtures: evt_0001, evt_0002, ... */
export class SequentialIds implements IdGenerator {
  private readonly counters = new Map<IdPrefix, number>();

  next(prefix: IdPrefix): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }
}
