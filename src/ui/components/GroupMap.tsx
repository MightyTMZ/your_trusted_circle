import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import type { Participant } from '../../domain/types';
import type { LiveFix } from '../api';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { useLive } from '../hooks/useServerSession';
import { fitPlot, spreadOverlaps, toPlotPx, type PlotView } from '../mapFit';
import { useDemoVenue } from '../venue';
import { initials } from './Controls';
import { GoogleMap, googleMapsConfigured, type MapPin } from './GoogleMap';
import { syntheticPosition } from '../../shared/synthetic-location';

const M_PER_DEG = 111_320;
/** Room kept clear at the top of the plot for the map chip. */
const PAD_TOP_PX = 64;
/** Avatar diameter plus a small gap: pins closer than this get nudged apart. */
const PIN_GAP_PX = 40;

/** The synthetic venue, in metres east/north of the entrance. Drawn to scale so it zooms with the group. */
const BLOCKS = [
  { x0: -60, y0: 16, x1: -19, y1: 57 },
  { x0: 19, y0: 14, x1: 60, y1: 60 },
  { x0: -57, y0: -57, x1: -11, y1: -11 },
  { x0: 16, y0: -57, x1: 57, y1: -11 },
];
const STREET_HALF_M = 3.5;

export interface GroupPoint {
  participantId: string;
  name: string;
  isYou: boolean;
  /** Metres east/north of the map anchor. */
  x: number;
  y: number;
  lat: number;
  lng: number;
  live: boolean;
  /** Device GPS relayed by the server, or a simulated reading from this device. */
  source: 'device' | 'simulated';
  at: number;
}

/** The server's fix for this participant, if the server lets this viewer see one. */
export function liveFixFor(p: Participant, fixes: LiveFix[]): LiveFix | undefined {
  return fixes.find((f) => f.participantId === (p.serverId ?? p.id));
}

/**
 * Everyone this viewer may see, following each person's own permissions.
 * A real device fix wins over a simulated reading for the same person.
 */
export function useGroupPoints(viewer: Participant, now: number, at = now): { points: GroupPoint[]; anchor: { lat: number; lng: number } } {
  const { state } = useApp();
  const { fixes } = useLive();
  const session = state.session!;
  const { venue } = useDemoVenue();
  return useMemo(() => {
    // Simulated people are drawn around the demo venue; real fixes show where they really are.
    const anchor = { lat: venue.lat, lng: venue.lng };
    const cos = Math.cos((anchor.lat * Math.PI) / 180);
    const demoStart = session.demoStartedAt ?? null;
    const points: GroupPoint[] = [];
    for (const p of Object.values(state.participants)) {
      if (p.status !== 'active') continue;
      const fix = liveFixFor(p, fixes);
      if (fix) {
        const simulationIndex = demoStart === null || !fix.simulated ? null : simulatedParticipantIndex(p);
        if (simulationIndex !== null && demoStart !== null && at < demoStart) continue;
        const simulatedAt = simulationIndex !== null && demoStart !== null ? syntheticPosition((at - demoStart) / 1000, simulationIndex) : null;
        const position =
          simulatedAt
            ? simulatedAt
            : { x: (fix.longitude - anchor.lng) * M_PER_DEG * cos, y: (fix.latitude - anchor.lat) * M_PER_DEG };
        points.push({
          participantId: p.id,
          name: p.displayName,
          isYou: p.id === viewer.id,
          x: position.x,
          y: position.y,
          lat: simulatedAt === null ? fix.latitude : anchor.lat + position.y / M_PER_DEG,
          lng: simulatedAt === null ? fix.longitude : anchor.lng + position.x / (M_PER_DEG * cos),
          live: simulatedAt === null ? fix.status === 'live' : at >= now - 1000,
          source: fix.simulated ? 'simulated' : 'device',
          at: simulatedAt === null ? new Date(fix.fixAt).getTime() : at,
        });
        continue;
      }
      // Simulated readings exist only for people on this device.
      if (p.remote || p.consent.locationSharing === 'off' || !canViewLocation(session, viewer, p)) continue;
      const r = latestReading(p);
      if (!r) continue;
      points.push({
        participantId: p.id,
        name: p.displayName,
        isYou: p.id === viewer.id,
        x: r.x,
        y: r.y,
        lat: anchor.lat + r.y / M_PER_DEG,
        lng: anchor.lng + r.x / (M_PER_DEG * cos),
        live: participantFreshness(p, r, now, session.config.locationStaleAfterSec) === 'live',
        source: 'simulated',
        at: r.recordedAt,
      });
    }
    return { points, anchor };
  }, [state.participants, session, viewer, fixes, now, at, venue]);
}

function simulatedParticipantIndex(p: Participant): number | null {
  if (p.role === 'host') return -1;
  const match = p.displayName.match(/\(synthetic ([1-3])\)$/);
  return match ? Number(match[1]) - 1 : null;
}

function describe(points: GroupPoint[]): string {
  return points
    .map((pt) => {
      const who = pt.isYou ? 'You' : pt.name;
      const when = pt.live ? 'live' : `last known ${fmtTime(pt.at)}`;
      return `${who}, ${when}${pt.source === 'simulated' ? ', simulated' : ''}`;
    })
    .join('; ');
}

/**
 * The group map. Satellite imagery from Google when a Maps key is configured,
 * otherwise a synthetic venue plot. Shows only people whose own permissions
 * allow this viewer to see them.
 */
export function GroupMap({ points, anchor, alerting }: { points: GroupPoint[]; anchor: { lat: number; lng: number }; alerting: Set<string> }) {
  const [failed, setFailed] = useState(false);
  const described = describe(points);

  if (googleMapsConfigured && !failed) {
    const pins: MapPin[] = points.map((pt) => ({
      id: pt.participantId,
      label: pt.isYou ? 'You' : initials(pt.name),
      title: `${pt.isYou ? 'You' : pt.name}${pt.source === 'simulated' ? ' (simulated)' : ''}`,
      lat: pt.lat,
      lng: pt.lng,
      tone: alerting.has(pt.participantId) ? 'alert' : pt.live ? 'live' : 'stale',
      simulated: pt.source === 'simulated',
    }));
    return (
      <div role="region" aria-label="Group map">
        <p className="sr-only">{described || 'No shared locations yet.'}</p>
        <GoogleMap pins={pins} center={anchor} onFail={() => setFailed(true)} />
      </div>
    );
  }

  return <SyntheticPlot points={points} alerting={alerting} described={described} />;
}

/** Size of an element, kept current as the layout changes. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

/**
 * The synthetic venue plot. Auto-fits like the Google map: centred on the
 * middle of the group and zoomed so everyone fills the plot. Avatars that
 * would still overlap are nudged apart; their positions are unchanged.
 */
function SyntheticPlot({ points, alerting, described }: { points: GroupPoint[]; alerting: Set<string>; described: string }) {
  const { ref, w, h } = useSize<HTMLDivElement>();
  const view: PlotView = useMemo(() => fitPlot(points, w, h, { padTop: PAD_TOP_PX }), [points, w, h]);
  const px = (x: number, y: number) => toPlotPx({ x, y }, view);
  const placed = useMemo(() => {
    const at = points.map((pt) => toPlotPx(pt, view));
    const off = spreadOverlaps(at, PIN_GAP_PX);
    return at.map((p, i) => ({ x: p.x + off[i].x, y: p.y + off[i].y }));
  }, [points, view]);
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const a = px(x0, y1);
    const b = px(x1, y0);
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  };
  const far = 5_000;
  const entrance = px(0, 0);

  return (
    <div ref={ref} className="map" role="img" aria-label={`Synthetic venue map. ${described || 'No shared locations yet.'}`}>
      {w > 0 && (
        <>
          {BLOCKS.map((b, i) => (
            <div key={i} className="map-block" style={rect(b.x0, b.y0, b.x1, b.y1)} />
          ))}
          <div className="map-street" style={rect(-far, -STREET_HALF_M, far, STREET_HALF_M)} />
          <div className="map-street" style={rect(-STREET_HALF_M, -far, STREET_HALF_M, far)} />
          <div className="map-entrance" style={{ left: entrance.x, top: entrance.y }} />
          {points.map((pt, i) => {
            const hot = alerting.has(pt.participantId);
            return (
              <span
                key={pt.participantId}
                className={`av mark num ${hot ? 'on-danger' : pt.live ? 'fill' : 'stale'}${pt.source === 'simulated' ? ' sim' : ''}`}
                style={{ left: placed[i].x, top: placed[i].y }}
                aria-hidden="true"
              >
                {pt.isYou ? 'You' : initials(pt.name)}
              </span>
            );
          })}
        </>
      )}
    </div>
  );
}
