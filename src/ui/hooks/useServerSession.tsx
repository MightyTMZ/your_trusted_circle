import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { syncServerParticipants } from '../../domain/session';
import { fetchLiveLocations, fetchServerSession, sendLiveLocation, type LiveFix } from '../api';
import { useApp } from '../context';

export type GeoState = 'idle' | 'waiting' | 'on' | 'denied' | 'unavailable';

interface Live {
  /** Positions the server lets this viewer see. Held in memory only, never written to storage. */
  fixes: LiveFix[];
  /** This device's GPS, while you share location in a server session. */
  geo: GeoState;
  /** True once the server has answered at least once for this session. */
  connected: boolean;
}

const LiveCtx = createContext<Live>({ fixes: [], geo: 'idle', connected: false });

const SESSION_POLL_MS = 10_000;
const LOCATION_POLL_MS = 5_000;
const SEND_EVERY_MS = 10_000;

/**
 * Keeps a server-backed session in step with the server:
 * - the participant list (people who joined or left on other devices),
 * - this device's position, relayed while you share location,
 * - the group's positions you are allowed to see (docs/backend.md, "Live group location").
 * Sessions that exist only on this device are left alone.
 */
export function LiveLocationProvider({ children }: { children: ReactNode }) {
  const { state, me, store } = useApp();
  const session = state.session;
  const serverId = session?.serverId;
  const active = !!serverId && !!me && me.status === 'active' && session!.status !== 'ended';
  const sharing = active && session!.status === 'active' && me!.consent.locationSharing !== 'off' && me!.device.online;

  const [fixes, setFixes] = useState<LiveFix[]>([]);
  const [geo, setGeo] = useState<GeoState>('idle');
  const [connected, setConnected] = useState(false);

  // Participant list and session status.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      const view = await fetchServerSession(serverId!);
      if (!alive || !view) return;
      setConnected(true);
      store.dispatch((d, now) => syncServerParticipants(d, view, now));
    };
    poll();
    const id = setInterval(poll, SESSION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, serverId, store]);

  // Positions this viewer may see.
  useEffect(() => {
    if (!active) {
      setFixes([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      const next = await fetchLiveLocations(serverId!);
      if (alive && next) setFixes(next);
    };
    poll();
    const id = setInterval(poll, LOCATION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, serverId]);

  // This device's position. Stops as soon as sharing stops.
  const lastSent = useRef(0);
  useEffect(() => {
    if (!sharing) {
      setGeo('idle');
      return;
    }
    if (!('geolocation' in navigator)) {
      setGeo('unavailable');
      return;
    }
    setGeo('waiting');
    lastSent.current = 0;
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setGeo('on');
        const t = Date.now();
        if (t - lastSent.current < SEND_EVERY_MS) return;
        lastSent.current = t;
        sendLiveLocation(serverId!, {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
          // The relay compares against real time, so this uses the device fix time, not the demo clock.
          fixAt: new Date(Math.min(pos.timestamp, t)).toISOString(),
        });
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [sharing, serverId]);

  useEffect(() => setConnected(false), [serverId]);

  return <LiveCtx.Provider value={{ fixes, geo, connected }}>{children}</LiveCtx.Provider>;
}

export function useLive(): Live {
  return useContext(LiveCtx);
}
