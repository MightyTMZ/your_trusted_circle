/**
 * Retention. Traces older than RETENTION_DAYS, and sessions that ended (or
 * expired) before then together with their check-ins, incidents and alerts,
 * are deleted. A session with an active incident is kept until it is resolved.
 * Expired sign-ins are removed by MongoDB's TTL index.
 *
 * The Python pruning pipeline in the architecture can take this over later;
 * until then the API runs it hourly (main.ts).
 */
import type { Deps } from "../context.js";

export async function runRetention(deps: Deps) {
  const cutoff = new Date(deps.now().getTime() - deps.config.retentionDays * 24 * 60 * 60 * 1000);
  return deps.store.pruneBefore(cutoff);
}
