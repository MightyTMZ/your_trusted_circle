/**
 * How an alert reaches a recipient. Swappable so tests can simulate failures.
 *
 * - A YTC user (the host, or a backup contact who accepted an invite): the
 *   alert is their in-app inbox entry (GET /api/alerts).
 * - A backup contact without an account: simulated; the attempt is recorded.
 * - The simulated emergency step: triggers the voice-agent service (box 4 of
 *   the architecture) over REST, if VOICE_AGENT_URL is set. The request names
 *   the hard-coded mock operator endpoint only.
 *
 * Safety boundary (CLAUDE.md): there is no telephony here and no path to any
 * real emergency line. Real push notifications are deliberately not sent
 * (CLAUDE.md: no real external notifications; see docs/backend.md).
 */
import { MOCK_OPERATOR_ENDPOINT_ID } from "../../timeline/schema/envelope.js";
import type { ServerConfig } from "../config.js";
import type { NotificationJobDoc } from "../types.js";

export type DeliveryResult = { ok: true; simulated: boolean } | { ok: false; reason: string };

export interface Transport {
  deliver(job: NotificationJobDoc): Promise<DeliveryResult>;
}

/** What the voice-agent service receives. It fetches facts itself, with its service token. */
export interface VoiceEscalationRequest {
  incidentId: string;
  sessionId: string;
  mockEndpointId: typeof MOCK_OPERATOR_ENDPOINT_ID;
  briefingPath: string;
  voiceEventsPath: string;
}

export function createTransport(config: Pick<ServerConfig, "voiceAgentUrl" | "voiceAgentToken">, fetchImpl: typeof fetch = fetch): Transport {
  return {
    async deliver(job) {
      if (job.recipient.kind === "user") return { ok: true, simulated: false };
      if (job.recipient.kind === "backup_contact") return { ok: true, simulated: true };

      // Simulated emergency step.
      if (!config.voiceAgentUrl || !config.voiceAgentToken) return { ok: true, simulated: true };
      const body: VoiceEscalationRequest = {
        incidentId: job.incidentId,
        sessionId: job.sessionId,
        mockEndpointId: MOCK_OPERATOR_ENDPOINT_ID,
        briefingPath: `/api/service/incidents/${job.incidentId}/briefing`,
        voiceEventsPath: `/api/service/incidents/${job.incidentId}/voice-events`,
      };
      try {
        const res = await fetchImpl(`${config.voiceAgentUrl}/escalations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.voiceAgentToken}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok ? { ok: true, simulated: true } : { ok: false, reason: `voice_agent_${res.status}` };
      } catch {
        return { ok: false, reason: "voice_agent_unreachable" };
      }
    },
  };
}

/** No voice-agent service: every delivery is recorded as simulated. */
export const defaultTransport: Transport = createTransport({ voiceAgentUrl: null, voiceAgentToken: null });
