import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import type { Participant } from '../../domain/types';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { initials } from './Controls';

const RANGE_M = 60;

/** Synthetic venue plot. Shows only people whose own permissions allow this viewer to see them. */
export function GroupMap({ viewer, now, alerting }: { viewer: Participant; now: number; alerting: Set<string> }) {
  const { state } = useApp();
  const session = state.session!;
  // Metres from the venue entrance to a percentage of the plot, kept off the edges.
  const pos = (m: number) => Math.max(6, Math.min(94, 50 + (m / RANGE_M) * 44));

  const points = Object.values(state.participants)
    .filter((p) => p.status === 'active' && canViewLocation(session, viewer, p) && p.consent.locationSharing !== 'off')
    .map((p) => ({ p, r: latestReading(p) }))
    .filter((x): x is { p: Participant; r: NonNullable<ReturnType<typeof latestReading>> } => !!x.r);

  const described = points
    .map(({ p, r }) => {
      const live = participantFreshness(p, r, now, session.config.locationStaleAfterSec) === 'live';
      return `${p.id === viewer.id ? 'You' : p.displayName}, ${live ? 'live' : `stale since ${fmtTime(r.recordedAt)}`}`;
    })
    .join('; ');

  return (
    <div className="map" role="img" aria-label={`Synthetic venue map. ${described || 'No shared locations yet.'}`}>
      <div className="map-block" style={{ left: '6%', top: '8%', width: '30%', height: '30%' }} />
      <div className="map-block" style={{ left: '64%', top: '6%', width: '30%', height: '34%' }} />
      <div className="map-block" style={{ left: '8%', top: '58%', width: '34%', height: '34%' }} />
      <div className="map-block" style={{ left: '62%', top: '58%', width: '30%', height: '34%' }} />
      <div className="map-street" style={{ left: 0, right: 0, top: 'calc(50% - 5px)', height: 10 }} />
      <div className="map-street" style={{ top: 0, bottom: 0, left: 'calc(50% - 5px)', width: 10 }} />
      <div className="map-entrance" style={{ left: '50%', top: '50%' }} />
      {points.map(({ p, r }) => {
        const live = participantFreshness(p, r, now, session.config.locationStaleAfterSec) === 'live';
        const hot = alerting.has(p.id);
        return (
          <span
            key={p.id}
            className={`av mark num ${hot ? 'on-accent' : live ? 'glass-2' : 'stale'}`}
            style={{ left: `${pos(r.x)}%`, top: `${100 - pos(r.y)}%` }}
            aria-hidden="true"
          >
            {p.id === viewer.id ? 'You' : initials(p.displayName)}
          </span>
        );
      })}
    </div>
  );
}
