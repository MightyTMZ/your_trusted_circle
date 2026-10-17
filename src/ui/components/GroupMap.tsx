import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import type { Participant } from '../../domain/types';
import { useApp } from '../context';
import { fmtTime } from '../format';

const RANGE_M = 60;

/** Synthetic venue plot. Shows only people whose own permissions allow this viewer to see them. */
export function GroupMap({ viewer, now }: { viewer: Participant; now: number }) {
  const { state } = useApp();
  const session = state.session!;
  const W = 340;
  const H = 240;
  const sx = (x: number) => W / 2 + (x / RANGE_M) * (W / 2 - 20);
  const sy = (y: number) => H / 2 - (y / RANGE_M) * (H / 2 - 20);

  const points = Object.values(state.participants)
    .filter((p) => canViewLocation(session, viewer, p) && p.consent.locationSharing !== 'off')
    .map((p) => ({ p, r: latestReading(p) }))
    .filter((x): x is { p: Participant; r: NonNullable<ReturnType<typeof latestReading>> } => !!x.r);

  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Synthetic venue map of shared locations">
      <line x1={W / 2} y1={12} x2={W / 2} y2={H - 12} stroke="var(--line)" />
      <line x1={12} y1={H / 2} x2={W - 12} y2={H / 2} stroke="var(--line)" />
      <rect x={W / 2 - 4} y={H / 2 - 4} width={8} height={8} fill="var(--faint)" />
      <text x={W / 2 + 8} y={H / 2 - 8} fill="var(--faint)" fontSize="10">
        Venue entrance (synthetic)
      </text>
      {points.map(({ p, r }) => {
        const live = participantFreshness(p, r, now, session.config.locationStaleAfterSec) === 'live';
        const cx = Math.max(10, Math.min(W - 10, sx(r.x)));
        const cy = Math.max(10, Math.min(H - 10, sy(r.y)));
        return (
          <g key={p.id}>
            <circle
              cx={cx}
              cy={cy}
              r={6}
              fill={live ? 'var(--live)' : 'var(--bg)'}
              stroke={live ? 'var(--live)' : 'var(--muted)'}
              strokeWidth={1.5}
              strokeDasharray={live ? undefined : '2 2'}
            />
            <text x={cx + 10} y={cy + 4} fill={live ? 'var(--text)' : 'var(--muted)'} fontSize="11">
              {p.id === viewer.id ? 'You' : p.displayName}
              {live ? '' : ` · stale ${fmtTime(r.recordedAt)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
