import type { LocationReading, Millis, Participant, Session } from './types';

export type Freshness = 'live' | 'stale';

export function latestReading(p: Participant): LocationReading | undefined {
  return p.locations[p.locations.length - 1];
}

/**
 * Only the most recent reading can be live, and only while it is younger than
 * the stale threshold. Every older reading is stale by definition.
 */
export function freshness(
  reading: LocationReading,
  opts: { isLatest: boolean; sourceOnline: boolean },
  now: Millis,
  staleAfterSec: number,
): Freshness {
  if (!opts.isLatest || !opts.sourceOnline) return 'stale';
  return now - reading.recordedAt <= staleAfterSec * 1000 ? 'live' : 'stale';
}

export function participantFreshness(p: Participant, reading: LocationReading, now: Millis, staleAfterSec: number): Freshness {
  return freshness(reading, { isLatest: reading === latestReading(p), sourceOnline: p.device.online }, now, staleAfterSec);
}

/** Whether `viewer` may see `subject`'s location under the subject's own permissions. */
export function canViewLocation(session: Session, viewer: Participant, subject: Participant): boolean {
  if (viewer.id === subject.id) return true;
  if (subject.status !== 'active' || viewer.status !== 'active') return false;
  if (session.status === 'ended') return false;
  switch (subject.consent.locationSharing) {
    case 'group':
      return true;
    case 'host':
      return viewer.id === session.hostId;
    case 'off':
      return false;
  }
}

export function describeOffset(r: LocationReading): string {
  const d = Math.round(Math.hypot(r.x, r.y));
  if (d < 5) return 'At the venue entrance';
  const deg = (Math.atan2(r.x, r.y) * 180) / Math.PI;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const dir = dirs[(Math.round(deg / 45) + 8) % 8];
  return `${d} m ${dir} of venue entrance`;
}

/** Simulated position input. Random walk around the synthetic venue. */
export function nextSimulatedReading(prev: LocationReading | undefined, now: Millis): LocationReading {
  const base = prev ?? { x: (Math.random() - 0.5) * 60, y: (Math.random() - 0.5) * 60 };
  return {
    x: Math.round(base.x + (Math.random() - 0.5) * 8),
    y: Math.round(base.y + (Math.random() - 0.5) * 8),
    accuracyM: 5 + Math.round(Math.random() * 10),
    recordedAt: now,
    source: 'simulated',
  };
}
