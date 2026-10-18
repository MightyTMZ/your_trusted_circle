/**
 * GET /api/sessions/:id/story — what happened in a session, told in plain
 * sentences, as the caller may see it. The "What happened" sheet reads it.
 *
 * Sources, each limited by the same rules as the rest of the API:
 * - Membership: who joined and left (every member sees this).
 * - Alerts: an incident's own log, which says why it opened, who was alerted,
 *   the escalation and the simulated call (the host and the person it is
 *   about only, as GET /api/sessions/:id/timeline).
 * - Movements: only where a record of positions exists. Live positions are
 *   relayed and never stored (docs/backend.md), so for most people there is
 *   none and the story says so. The live incident demo keeps its person's
 *   synthetic evening in memory (demo/live-demo.ts), the same record the
 *   simulated call cites; its positions are told to whoever that person
 *   shares location with: the group, or the host only.
 */
import { Hono } from "hono";
import type { TimelineEvent } from "../../timeline/schema/catalog.js";
import { anyParticipant, isHost } from "../auth/authz.js";
import { requireAuth } from "../auth/session.js";
import { fail, type AppEnv, type Deps } from "../context.js";
import type { ParticipantDoc, SessionDoc } from "../types.js";

export interface StoryItem {
  at: string;
  kind: "session" | "movement" | "alert";
  text: string;
  /** For movements and alerts: whose story this is. */
  participantId?: string;
}

export interface Story {
  items: StoryItem[];
  /** People in the session whose movements have no record to tell, by name. */
  noMovementRecord: string[];
}

/** Whether `viewer` may see where `subject` was, under the subject's own sharing choice. */
function mayFollow(session: SessionDoc, viewer: ParticipantDoc, subject: ParticipantDoc): boolean {
  if (viewer.participantId === subject.participantId) return true;
  if (subject.consent.locationSharing === "group") return true;
  return isHost(session, viewer.userId) && subject.consent.locationSharing === "host";
}

const M_PER_DEG = 111_320;
function metres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const cos = Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  return Math.hypot((b.latitude - a.latitude) * M_PER_DEG, (b.longitude - a.longitude) * M_PER_DEG * cos);
}

const HEADINGS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const heading = (deg: number) => HEADINGS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** "Toronto City Hall, main room (simulated)" -> "the main room"; a label without a part is kept whole. */
function place(label: string): string {
  const part = label.split(",").slice(1).join(",").replace(/\s*\(simulated\)\s*$/, "").trim();
  return part ? `the ${part}` : label;
}

/** Location fixes told as arrivals, moves between places, and walking. */
export function movementStory(name: string, fixes: TimelineEvent<"location.reported">[]): StoryItem[] {
  const items: StoryItem[] = [];
  let lastLabel: string | null = null;
  let last: TimelineEvent<"location.reported"> | null = null;
  for (const f of fixes) {
    const d = f.data;
    const simulated = d.source === "synthetic" ? " (simulated)" : "";
    const base = { at: f.occurred_at, kind: "movement" as const, participantId: f.participant_id ?? undefined };
    if (!last) {
      items.push({ ...base, text: d.place_label ? `${name} arrived at ${d.place_label}.` : `${name}'s first position was recorded${simulated}.` });
    } else if (d.place_label && lastLabel && d.place_label !== lastLabel) {
      items.push({ ...base, text: `${name} moved from ${place(lastLabel)} to ${place(d.place_label)}, about ${Math.round(metres(last.data, d))} m${simulated}.` });
    } else if (d.place_label && !lastLabel) {
      items.push({ ...base, text: `${name} reached ${d.place_label}, about ${Math.round(metres(last.data, d))} m from the last position.` });
    } else if (!d.place_label && d.speed_m_s !== null && d.speed_m_s >= 0.5) {
      const dir = d.heading_deg !== null ? ` heading ${heading(d.heading_deg)}` : "";
      items.push({ ...base, text: `${name} was walking at about ${d.speed_m_s.toFixed(1)} m/s${dir}${lastLabel ? `, away from ${place(lastLabel)}` : ""}${simulated}.` });
    }
    if (d.place_label) lastLabel = d.place_label;
    last = f;
  }
  return items;
}

export function storyRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get("/sessions/:id/story", requireAuth(deps), async (c) => {
    const session = await deps.store.getSession(c.req.param("id"));
    const viewer = session ? anyParticipant(session, c.var.user._id) : undefined;
    if (!session || !viewer) return fail(c, 404, "no_session", "Session not found.");
    const host = isHost(session, viewer.userId);
    const items: StoryItem[] = [{ at: session.createdAt.toISOString(), kind: "session", text: "The session started." }];

    for (const p of session.participants) {
      if (p.role !== "host") items.push({ at: p.joinedAt.toISOString(), kind: "session", text: `${p.displayName} joined.` });
      if (p.leftAt) items.push({ at: p.leftAt.toISOString(), kind: "session", text: `${p.displayName} left.` });
    }

    for (const inc of await deps.store.listIncidentsForSession(session._id)) {
      if (!host && inc.participantId !== viewer.participantId) continue;
      const who = session.participants.find((p) => p.participantId === inc.participantId)?.displayName ?? "Someone";
      items.push({ at: inc.openedAt.toISOString(), kind: "alert", participantId: inc.participantId, text: `An alert opened about ${who}.` });
      for (const l of inc.log) items.push({ at: l.at.toISOString(), kind: "alert", participantId: inc.participantId, text: l.text });
      if (inc.acknowledged) items.push({ at: inc.acknowledged.at.toISOString(), kind: "alert", participantId: inc.participantId, text: `${inc.acknowledged.name} acknowledged the alert about ${who}.` });
      if (inc.resolved) items.push({ at: inc.resolved.at.toISOString(), kind: "alert", participantId: inc.participantId, text: `${inc.resolved.name} resolved the alert about ${who}.` });
    }

    // Movements: only the demo keeps a record of positions, and only for its person.
    const told = new Set<string>();
    const run = deps.demos?.get(session._id);
    if (run) {
      const subject = session.participants.find((p) => p.participantId === run.view().participantId);
      if (subject && mayFollow(session, viewer, subject)) {
        const fixes = run.timeline.events.filter(
          (e): e is TimelineEvent<"location.reported"> => e.type === "location.reported" && e.participant_id === subject.participantId,
        );
        items.push(...movementStory(subject.displayName, fixes));
        if (fixes.length > 0) told.add(subject.participantId);
      }
    }

    items.sort((a, b) => a.at.localeCompare(b.at));
    const story: Story = {
      items,
      noMovementRecord: session.participants.filter((p) => p.leftAt === null && !told.has(p.participantId)).map((p) => p.displayName),
    };
    return c.json(story);
  });
  return r;
}
