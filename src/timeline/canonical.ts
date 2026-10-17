/**
 * Serialization helpers: a canonical form for hashing and a stable,
 * reader-friendly field order for JSONL lines.
 */
import { createHash } from "node:crypto";
import type { TimelineEvent } from "./schema/catalog.js";

/** JSON with recursively sorted keys and no whitespace. Rejects values JSON cannot represent faithfully. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

/** sha256 over the canonical form of the event without its own hash. */
export function hashEvent(event: object): string {
  const { hash: _ignored, ...rest } = event as { hash?: unknown };
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

/**
 * Field order for JSONL lines: identity and time first, then the
 * human-readable summary, then structured detail, then integrity fields.
 * Readers (including the voice agent) can stop after `summary`.
 */
const LINE_ORDER = [
  "schema_version",
  "seq",
  "event_id",
  "occurred_at",
  "recorded_at",
  "type",
  "category",
  "session_id",
  "incident_id",
  "participant_id",
  "summary",
  "actor",
  "provenance",
  "caused_by",
  "data",
  "prev_hash",
  "hash",
] as const satisfies readonly (keyof TimelineEvent)[];

/** One JSONL line (without the trailing newline). */
export function serializeEvent(event: TimelineEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of LINE_ORDER) ordered[key] = event[key];
  return JSON.stringify(ordered);
}
