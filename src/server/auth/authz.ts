/**
 * Participant rules, in one place:
 * - Only members of a session can see or act in it.
 * - Only the host changes session rules, shows the invite, or ends it.
 * - A person changes only their own consent, check-ins and heartbeats.
 * - The host is everyone else's first responder, so alerts about any other
 *   participant go to the host first (safety/escalation.ts).
 */
import type { SessionDoc } from "../types.js";

export function isLive(s: SessionDoc, now: Date): boolean {
  return s.status === "active" && s.expiresAt.getTime() > now.getTime();
}

export function isHost(s: SessionDoc, userId: string): boolean {
  return s.hostUserId === userId;
}

/** The caller's participant entry, if they are currently in the session. */
export function activeParticipant(s: SessionDoc, userId: string) {
  return s.participants.find((p) => p.userId === userId && p.leftAt === null);
}

/** Anyone who was ever in the session, including people who left (they keep read access to their own data). */
export function anyParticipant(s: SessionDoc, userId: string) {
  return s.participants.find((p) => p.userId === userId);
}
