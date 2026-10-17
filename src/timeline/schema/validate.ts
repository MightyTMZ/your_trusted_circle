/**
 * Minimal runtime validator with static type inference. Kept in-house so
 * the timeline has zero runtime dependencies and every rule is auditable.
 *
 * Objects are strict: unknown keys are rejected so that no field (and no
 * unconsented personal data) can ride along unnoticed.
 */
import { parseIso } from "../../shared/clock.js";

export interface Issue {
  path: string;
  message: string;
}

export interface Schema<T> {
  check(value: unknown, path: string, issues: Issue[]): void;
  /** Phantom field for type inference only; never set at runtime. */
  readonly _type?: T;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

function schema<T>(check: Schema<T>["check"]): Schema<T> {
  return { check };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export const v = {
  string(opts: { minLength?: number; maxLength?: number; pattern?: RegExp } = {}): Schema<string> {
    return schema((value, path, issues) => {
      if (typeof value !== "string") {
        issues.push({ path, message: `expected string, got ${describe(value)}` });
        return;
      }
      if (opts.minLength !== undefined && value.length < opts.minLength) {
        issues.push({ path, message: `must be at least ${opts.minLength} characters` });
      }
      if (opts.maxLength !== undefined && value.length > opts.maxLength) {
        issues.push({ path, message: `must be at most ${opts.maxLength} characters` });
      }
      if (opts.pattern && !opts.pattern.test(value)) {
        issues.push({ path, message: `does not match ${opts.pattern}` });
      }
    });
  },

  /** Prefixed identifier such as "par_0001" or "inc_<uuid>". */
  id(prefix: string): Schema<string> {
    return v.string({ pattern: new RegExp(`^${prefix}_[A-Za-z0-9-]+$`) });
  },

  /** ISO 8601 UTC with milliseconds, as produced by toIso(). */
  timestamp(): Schema<string> {
    return schema((value, path, issues) => {
      if (typeof value !== "string" || parseIso(value) === null) {
        issues.push({ path, message: "expected ISO 8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)" });
      }
    });
  },

  number(opts: { min?: number; max?: number; integer?: boolean } = {}): Schema<number> {
    return schema((value, path, issues) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({ path, message: `expected finite number, got ${describe(value)}` });
        return;
      }
      if (opts.integer && !Number.isInteger(value)) issues.push({ path, message: "expected integer" });
      if (opts.min !== undefined && value < opts.min) issues.push({ path, message: `must be >= ${opts.min}` });
      if (opts.max !== undefined && value > opts.max) issues.push({ path, message: `must be <= ${opts.max}` });
    });
  },

  /** Accepts anything; for fields validated separately (e.g. payloads keyed by type). */
  unknown(): Schema<unknown> {
    return schema(() => {});
  },

  boolean(): Schema<boolean> {
    return schema((value, path, issues) => {
      if (typeof value !== "boolean") issues.push({ path, message: `expected boolean, got ${describe(value)}` });
    });
  },

  literal<const L extends string | number | boolean>(expected: L): Schema<L> {
    return schema((value, path, issues) => {
      if (value !== expected) issues.push({ path, message: `expected ${JSON.stringify(expected)}` });
    });
  },

  enum<const E extends readonly string[]>(values: E): Schema<E[number]> {
    return schema((value, path, issues) => {
      if (typeof value !== "string" || !values.includes(value)) {
        issues.push({ path, message: `expected one of ${values.join(", ")}` });
      }
    });
  },

  array<T>(item: Schema<T>, opts: { minLength?: number; maxLength?: number } = {}): Schema<T[]> {
    return schema((value, path, issues) => {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected array, got ${describe(value)}` });
        return;
      }
      if (opts.minLength !== undefined && value.length < opts.minLength) {
        issues.push({ path, message: `must contain at least ${opts.minLength} item(s)` });
      }
      if (opts.maxLength !== undefined && value.length > opts.maxLength) {
        issues.push({ path, message: `must contain at most ${opts.maxLength} item(s)` });
      }
      value.forEach((entry, i) => item.check(entry, `${path}[${i}]`, issues));
    });
  },

  object<const S extends Shape>(shape: S): Schema<InferShape<S>> {
    return schema((value, path, issues) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ path, message: `expected object, got ${describe(value)}` });
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!(key in shape)) issues.push({ path: join(path, key), message: "unknown field" });
      }
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldValue = record[key];
        if (fieldValue === undefined) {
          if (!("optional" in fieldSchema)) issues.push({ path: join(path, key), message: "required" });
          continue;
        }
        fieldSchema.check(fieldValue, join(path, key), issues);
      }
    });
  },

  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    return {
      optional: true,
      check: (value, path, issues) => {
        if (value !== undefined) inner.check(value, path, issues);
      },
    };
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return schema((value, path, issues) => {
      if (value !== null) inner.check(value, path, issues);
    });
  },
};

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export function validate<T>(s: Schema<T>, value: unknown, path = ""): Issue[] {
  const issues: Issue[] = [];
  s.check(value, path, issues);
  return issues;
}
