/**
 * How an alert reaches a recipient. Swappable so a push service can replace
 * the in-app inbox later, and so tests can simulate failures.
 *
 * Safety boundary (CLAUDE.md): there is no telephony here and no path to any
 * real emergency line. Backup contacts and the simulated emergency step are
 * synthetic recipients delivered through a mock that only records the attempt.
 */
import type { NotificationJobDoc } from "../types.js";

export type DeliveryResult = { ok: true; simulated: boolean } | { ok: false; reason: string };

export interface Transport {
  deliver(job: NotificationJobDoc): Promise<DeliveryResult>;
}

export const defaultTransport: Transport = {
  async deliver(job) {
    // A YTC user's alert is their inbox entry (GET /api/alerts); storing the job is the delivery.
    if (job.recipient.kind === "user") return { ok: true, simulated: false };
    return { ok: true, simulated: true };
  },
};
