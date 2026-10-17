import { useMemo, useState } from 'react';
import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import type { Participant } from '../../domain/types';
import type { LiveFix } from '../api';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { useLive } from '../hooks/useServerSession';
import { useDemoVenue } from '../venue';
import { initials } from './Controls';
import { GoogleMap, googleMapsConfigured, type MapPin } from './GoogleMap';

const RANGE_M = 60;
const M_PER_DEG = 111_320;

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
export function useGroupPoints(viewer: Participant, now: number): { points: GroupPoint[]; anchor: { lat: number; lng: number } } {
  const { state } = useApp();
  const { fixes } = useLive();
  const session = state.session!;
  const { venue } = useDemoVenue();
  return useMemo(() => {
    // Simulated people are drawn around the demo venue; real fixes show where they really are.
    const anchor = { lat: venue.lat, lng: venue.lng };
    const cos = Math.cos((anchor.lat * Math.PI) / 180);
    const points: GroupPoint[] = [];
    for (const p of Object.values(state.participants)) {
      if (p.status !== 'active') continue;
      const fix = liveFixFor(p, fixes);
      if (fix) {
        points.push({
          participantId: p.id,
          name: p.displayName,
          isYou: p.id === viewer.id,
          x: (fix.longitude - anchor.lng) * M_PER_DEG * cos,
          y: (fix.latitude - anchor.lat) * M_PER_DEG,
          lat: fix.latitude,
          lng: fix.longitude,
          live: fix.status === 'live',
          source: fix.simulated ? 'simulated' : 'device',
          at: new Date(fix.fixAt).getTime(),
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
  }, [state.participants, session, viewer, fixes, now, venue]);
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

  // Metres from the anchor to a percentage of the plot, kept off the edges.
  const pos = (m: number) => Math.max(6, Math.min(94, 50 + (m / RANGE_M) * 44));
  return (
    <div className="map" role="img" aria-label={`Synthetic venue map. ${described || 'No shared locations yet.'}`}>
      <div className="map-block" style={{ left: '6%', top: '8%', width: '30%', height: '30%' }} />
      <div className="map-block" style={{ left: '64%', top: '6%', width: '30%', height: '34%' }} />
      <div className="map-block" style={{ left: '8%', top: '58%', width: '34%', height: '34%' }} />
      <div className="map-block" style={{ left: '62%', top: '58%', width: '30%', height: '34%' }} />
      <div className="map-street" style={{ left: 0, right: 0, top: 'calc(50% - 5px)', height: 10 }} />
      <div className="map-street" style={{ top: 0, bottom: 0, left: 'calc(50% - 5px)', width: 10 }} />
      <div className="map-entrance" style={{ left: '50%', top: '50%' }} />
      {points.map((pt) => {
        const hot = alerting.has(pt.participantId);
        return (
          <span
            key={pt.participantId}
            className={`av mark num ${hot ? 'on-accent' : pt.live ? 'fill' : 'stale'}${pt.source === 'simulated' ? ' sim' : ''}`}
            style={{ left: `${pos(pt.x)}%`, top: `${100 - pos(pt.y)}%` }}
            aria-hidden="true"
          >
            {pt.isYou ? 'You' : initials(pt.name)}
          </span>
        );
      })}
    </div>
  );
}
