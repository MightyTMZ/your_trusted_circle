import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { applyServerTimeline, checkInNeedsSync } from '../../domain/serverAlerts';
import { syncServerParticipants } from '../../domain/session';
import type { AppState, CheckIn } from '../../domain/types';
import {
  fetchLiveLocations,
  fetchServerAlerts,
  fetchServerSession,
  fetchServerTimeline,
  requestHelpOnServer,
  respondCheckInOnServer,
  sendLiveLocation,
  sendHeartbeat,
  startCheckInOnServer,
  type LiveFix,
} from '../api';
import { useApp } from '../context';
import { applySessionVenue, useDemoVenue } from '../venue';

/** `demo`: a demo venue is set, so this phone reports a simulated position there instead of GPS. */
export type GeoState = 'idle' | 'waiting' | 'on' | 'denied' | 'unavailable' | 'demo';

interface Live {
  /** Positions the server lets this viewer see. Held in memory only, never written to storage. */
  fixes: LiveFix[];
  /** This device's GPS, while you share location in a server session. */
  geo: GeoState;
  /** True once the server has answered at least once for this session. */
  connected: boolean;
  /** Fetch the server's incidents now, e.g. right after acknowledging. */
  refreshAlerts(): Promise<void>;
}

const LiveCtx = createContext<Live>({ fixes: [], geo: 'idle', connected: false, refreshAlerts: async () => {} });

const SESSION_POLL_MS = 10_000;
const ALERT_POLL_MS = 3_000;
const LOCATION_POLL_MS = 5_000;
const HEARTBEAT_MS = 30_000;
const SEND_EVERY_MS = 10_000;

/**
 * Keeps a server-backed session in step with the server:
 * - the participant list (people who joined or left on other devices),
 * - this device's position, relayed while you share location,
 * - the group's positions you are allowed to see (docs/backend.md, "Live group location"),
 * - check-ins and incidents: this device reports its check-ins and answers, and
 *   shows the server's incidents (src/domain/serverAlerts.ts). The server owns
 *   every deadline, so a closed phone still alerts the host.
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
  const sessionRequest = useRef(0);
  const locationRequest = useRef(0);
  const alertsRequest = useRef(0);

  // Participant list and session status.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      const request = ++sessionRequest.current;
      const view = await fetchServerSession(serverId!);
      if (!alive || request !== sessionRequest.current) return;
      if (!view) {
        setConnected(false);
        return;
      }
      setConnected(true);
      store.dispatch((d, now) => syncServerParticipants(d, view, now));
      applySessionVenue(view.rules.demoVenue ?? null);
    };
    poll();
    const id = setInterval(poll, SESSION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, serverId, store]);

  // keep the server's device status accurate even when location sharing is off
  useEffect(() => {
    if (!active) return;
    const heartbeat = () => void sendHeartbeat(serverId!);
    heartbeat();
    const id = setInterval(heartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [active, serverId]);

  // Leaving the session leaves its demo venue behind.
  useEffect(() => {
    if (!active) applySessionVenue(null);
  }, [active]);

  // Positions this viewer may see.
  useEffect(() => {
    if (!active) {
      setFixes([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      const request = ++locationRequest.current;
      const next = await fetchLiveLocations(serverId!);
      if (!alive || request !== locationRequest.current) return;
      setFixes(next ?? []);
    };
    poll();
    const id = setInterval(poll, LOCATION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, serverId]);

  // Demo venue set for the session: every phone that shares location reports a
  // simulated position near it instead of its GPS, labelled simulated for everyone.
  const { venue, shared: demoOn } = useDemoVenue();
  const offset = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!sharing || !demoOn) return;
    setGeo('demo');
    const M_PER_DEG = 111_320;
    const send = () => {
      const prev = offset.current ?? { x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 30 };
      const clamp = (m: number) => Math.max(-25, Math.min(25, m));
      const next = { x: clamp(prev.x + (Math.random() - 0.5) * 6), y: clamp(prev.y + (Math.random() - 0.5) * 6) };
      offset.current = next;
      sendLiveLocation(serverId!, {
        latitude: venue.lat + next.y / M_PER_DEG,
        longitude: venue.lng + next.x / (M_PER_DEG * Math.cos((venue.lat * Math.PI) / 180)),
        accuracyM: 10,
        fixAt: new Date().toISOString(),
        simulated: true,
      });
    };
    send();
    const id = setInterval(send, SEND_EVERY_MS);
    return () => clearInterval(id);
  }, [sharing, demoOn, venue.lat, venue.lng, serverId]);

  // This device's position. Stops as soon as sharing stops, and pauses while a demo venue is set.
  const lastSent = useRef(0);
  useEffect(() => {
    if (!sharing || demoOn) {
      if (!sharing) setGeo('idle');
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
  }, [sharing, demoOn, serverId]);

  useEffect(() => setConnected(false), [serverId]);

  // Incidents keep escalating after a session ends, so alerts sync for as long as you're in it.
  const alertsOn = !!serverId && !!me;
  const meId = me?.id;
  const refreshAlerts = useCallback(async () => {
    if (!alertsOn || !meId) return;
    const request = ++alertsRequest.current;
    const [timeline, alerts] = await Promise.all([fetchServerTimeline(serverId!), fetchServerAlerts()]);
    if (request !== alertsRequest.current) return;
    if (!timeline) return;
    store.dispatch((d) => applyServerTimeline(d, { ...timeline, alerts: alerts ?? [] }, meId));
  }, [alertsOn, serverId, meId, store]);

  // Report this device's check-ins and answers. Retried on every pass until the server has them.
  const inFlight = useRef(new Set<string>());
  const tried = useRef(new Set<string>());
  const syncCheckIns = useCallback(async () => {
    if (!alertsOn || !meId) return;
    const s: AppState = store.getState();
    const mine = s.checkIns.filter((c) => c.participantId === meId && checkInNeedsSync(c));
    for (const c of mine) {
      if (inFlight.current.has(c.id)) continue;
      inFlight.current.add(c.id);
      tried.current.add(`${c.id}:${c.status}`);
      try {
        await syncCheckIn(c, serverId!, store.dispatch);
      } finally {
        inFlight.current.delete(c.id);
      }
    }
    if (mine.length > 0) await refreshAlerts();
  }, [alertsOn, serverId, meId, store, refreshAlerts]);

  useEffect(() => {
    if (!alertsOn) return;
    let alive = true;
    const pass = async () => {
      await syncCheckIns();
      if (alive) await refreshAlerts();
    };
    pass();
    const id = setInterval(pass, ALERT_POLL_MS);
    // A new local check-in or answer is sent at once; failed sends are retried by the poll.
    const unsub = store.subscribe(() => {
      const fresh = store
        .getState()
        .checkIns.some((c) => c.participantId === meId && checkInNeedsSync(c) && !tried.current.has(`${c.id}:${c.status}`));
      if (fresh) syncCheckIns();
    });
    return () => {
      alive = false;
      clearInterval(id);
      unsub();
    };
  }, [alertsOn, meId, store, syncCheckIns, refreshAlerts]);

  return <LiveCtx.Provider value={{ fixes, geo, connected, refreshAlerts }}>{children}</LiveCtx.Provider>;
}

type Dispatch = (m: (d: AppState) => void) => string | null;

async function syncCheckIn(c: CheckIn, serverId: string, dispatch: Dispatch): Promise<void> {
  const update = (patch: Partial<NonNullable<CheckIn['server']>>, deadline?: Pick<CheckIn, 'promptedAt' | 'dueAt'>) =>
    dispatch((d) => {
      const x = d.checkIns.find((y) => y.id === c.id);
      if (x) {
        x.server = { ...x.server, ...patch } as NonNullable<CheckIn['server']>;
        if (deadline) Object.assign(x, deadline);
      }
    });

  if (!c.server) {
    // Asked for help before the server had the check-in: asking for help is never dropped.
    if (c.status === 'requested_help') {
      const r = await requestHelpOnServer(serverId);
      if (r.ok) update({ id: null, refused: 'sent_as_help', responseSent: true });
      return;
    }
    const r = await startCheckInOnServer(serverId);
    if (r.ok) {
      return void update(
        { id: r.data.checkIn.id },
        { promptedAt: Date.parse(r.data.checkIn.promptedAt), dueAt: Date.parse(r.data.checkIn.dueAt) },
      );
    }
    // Refused (an alert about you is already open, or monitoring is off on the server): stop asking here.
    if (r.code) {
      update({ id: null, refused: r.code });
      dispatch((d) => {
        const x = d.checkIns.find((y) => y.id === c.id);
        if (x?.status === 'pending') x.status = 'cancelled';
      });
    }
    return;
  }
  if (!c.server.id) return;
  const r = await respondCheckInOnServer(c.server.id, c.status === 'requested_help' ? 'help' : 'ok');
  // `checkin_closed`: the server's deadline passed first; its alert stands and the next poll shows it.
  if (r.ok || r.code) update({ responseSent: true });
}

export function useLive(): Live {
  return useContext(LiveCtx);
}
