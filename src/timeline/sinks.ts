/**
 * Where appended events go. The timeline writes each event to every sink
 * before committing it in memory, so a failed write never leaves a gap.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { TimelineEvent } from "./schema/catalog.js";

export interface TimelineSink {
  /** `line` is the serialized JSONL line without a trailing newline. */
  write(event: TimelineEvent, line: string): void;
}

/** Keeps lines in memory; useful for tests and for streaming to a UI. */
export class MemorySink implements TimelineSink {
  readonly lines: string[] = [];

  write(_event: TimelineEvent, line: string): void {
    this.lines.push(line);
  }

  toJsonl(): string {
    return this.lines.map((l) => `${l}\n`).join("");
  }
}

/** Append-only JSONL file. One line per event, written synchronously in order. */
export class JsonlFileSink implements TimelineSink {
  private fd: number | null;

  /**
   * @param durable fsync after every line so an event survives a crash once
   *   append() returns. Slower; leave off for tests.
   */
  constructor(
    readonly path: string,
    private readonly durable = false,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  write(_event: TimelineEvent, line: string): void {
    if (this.fd === null) throw new Error(`JsonlFileSink for ${this.path} is closed`);
    writeSync(this.fd, `${line}\n`);
    if (this.durable) fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
