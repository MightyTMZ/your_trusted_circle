/**
 * Fixed-window rate limits, in memory. Keys are a hash of the sign-in cookie
 * when present (so a signed-in person is limited as themselves), otherwise
 * the client IP from X-Forwarded-For when TRUST_PROXY=true. IPs live only in
 * this map for one window; they are never logged or stored.
 *
 * Limitation: per process. Several API instances (or serverless) would each
 * keep their own counts; a shared store (e.g. Redis INCR with expiry) would
 * make the limits global.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { fail } from "../context.js";
import { sha256 } from "../ids.js";
import { SESSION_COOKIE } from "./session.js";

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: () => Date) {}

  /** Counts one hit. Returns how long to wait, in seconds, if over the limit. */
  take(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now().getTime();
    if (this.windows.size > 50_000) for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= limit ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
}

function clientKey(c: Context, trustProxy: boolean): string {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) return `s:${sha256(token)}`;
  if (trustProxy) {
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
    if (ip) return `ip:${ip}`;
  }
  return "anon";
}

export function rateLimit(limiter: RateLimiter, name: string, limit: number, windowMs: number, trustProxy: boolean): MiddlewareHandler {
  return async (c, next) => {
    const result = limiter.take(`${name}:${clientKey(c, trustProxy)}`, limit, windowMs);
    if (!result.ok) {
      c.header("Retry-After", String(result.retryAfterSec));
      return fail(c, 429, "too_many_requests", `Too many requests. Try again in ${result.retryAfterSec} seconds.`);
    }
    await next();
  };
}
