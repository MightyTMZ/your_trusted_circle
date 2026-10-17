/**
 * JSONL import/export. One event per line, UTF-8, newline-terminated.
 */
import { readFileSync } from "node:fs";
import { serializeEvent } from "./canonical.js";
import type { TimelineEvent } from "./schema/catalog.js";
import { Timeline, type TimelineOptions } from "./timeline.js";

export interface JsonlLineError {
  /** 1-based line number in the source text. */
  line: number;
  message: string;
}

export interface ParsedJsonl {
  records: unknown[];
  errors: JsonlLineError[];
}

export function toJsonl(events: readonly TimelineEvent[]): string {
  return events.map((e) => `${serializeEvent(e)}\n`).join("");
}

/**
 * Splits JSONL text into parsed records without validating them. Blank
 * lines are skipped; a truncated last line (e.g. a crash mid-write) is
 * reported as an error rather than silently dropped.
 */
export function parseJsonl(text: string): ParsedJsonl {
  const records: unknown[] = [];
  const errors: JsonlLineError[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      errors.push({ line: i + 1, message: err instanceof Error ? err.message : String(err) });
    }
  });
  return { records, errors };
}

/** Parses and fully verifies a JSONL timeline. Throws on any malformed line or invalid event. */
export function timelineFromJsonl(text: string, opts: TimelineOptions): Timeline {
  const { records, errors } = parseJsonl(text);
  if (errors.length > 0) {
    throw new Error(`Malformed JSONL: ${errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
  }
  return Timeline.restore(records, opts);
}

export function readTimelineFile(path: string, opts: TimelineOptions): Timeline {
  return timelineFromJsonl(readFileSync(path, "utf8"), opts);
}
