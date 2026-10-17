import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { spreadOverlaps, worldPx, zoomForSpan } from '../mapFit';

/* Minimal typing for the parts of the Maps JavaScript API used here. */
declare global {
  interface Window {
    google?: any;
    gm_authFailure?: () => void;
    __ytcMapsReady?: () => void;
  }
}

export interface MapPin {
  id: string;
  label: string;
  title: string;
  lat: number;
  lng: number;
  /** Visual state, using the same avatar classes as everywhere else. */
  tone: 'alert' | 'live' | 'stale';
  simulated: boolean;
}

const API_KEY = import.meta.env.GOOGLE_MAPS_API_KEY?.trim() ?? '';
const MAP_ID = import.meta.env.GOOGLE_MAPS_MAP_ID?.trim() || 'DEMO_MAP_ID';

export const googleMapsConfigured = API_KEY.length > 0;

const M_PER_DEG = 111_320;
/** Closest zoom we use when the imagery limit at the venue is unknown. */
const DEFAULT_MAX_ZOOM = 20;
/** Never closer than this, even where imagery goes deeper: GPS is only good to a few metres. */
const HARD_MAX_ZOOM = 21;
/** A lone person or an empty map shows about this many metres across, whatever the map's size. */
const SINGLE_SPAN_M = 60;
/** Starting zoom before the map has been measured. */
const SINGLE_ZOOM = 19;
/** Avatar diameter plus a small gap: pins closer than this on screen get nudged apart. */
const PIN_GAP_PX = 40;

let loading: Promise<void> | null = null;
let authFailed = false;
const authListeners = new Set<() => void>();

/** Loads the Maps JavaScript API once. Rejects when the script can't load. */
export function loadGoogleMaps(): Promise<void> {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    window.__ytcMapsReady = () => resolve();
    // Google calls this when the key is invalid or not allowed for this site.
    window.gm_authFailure = () => {
      authFailed = true;
      authListeners.forEach((l) => l());
    };
    const s = document.createElement('script');
    const params = new URLSearchParams({ key: API_KEY, v: 'weekly', loading: 'async', libraries: 'marker', callback: '__ytcMapsReady' });
    s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    s.async = true;
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('maps script failed'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

function pinElement(pin: MapPin): HTMLElement {
  const el = document.createElement('span');
  updatePinElement(el, pin);
  return el;
}

function updatePinElement(el: HTMLElement, pin: MapPin) {
  const tone = pin.tone === 'alert' ? 'on-danger' : pin.tone === 'live' ? 'fill' : 'stale';
  el.className = `av pin num ${tone}${pin.simulated ? ' sim' : ''}`;
  el.textContent = pin.label;
}

/**
 * Satellite map with labels (Google's "hybrid" imagery). Calls `onFail` when
 * the API can't be used, so the caller can show the synthetic plot instead.
 */
export function GoogleMap(props: { pins: MapPin[]; center: { lat: number; lng: number }; onFail(): void }) {
  return (
    <MapBoundary onFail={props.onFail}>
      <GoogleMapInner {...props} />
    </MapBoundary>
  );
}

/** A Maps API failure must never take the rest of the screen with it. */
class MapBoundary extends Component<{ onFail(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function GoogleMapInner({ pins, center, onFail }: { pins: MapPin[]; center: { lat: number; lng: number }; onFail(): void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const markers = useRef(new Map<string, any>());
  const fitted = useRef('');
  /** The imagery's deepest zoom at the venue, from Google's MaxZoomService. */
  const maxZoom = useRef(DEFAULT_MAX_ZOOM);
  /** True once the person pans or zooms; auto-fit then waits until the group changes. */
  const userMoved = useRef(false);
  /** True while our own setCenter/setZoom is settling, so it isn't mistaken for the person moving the map. */
  const fitting = useRef(false);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const [ready, setReady] = useState(false);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  /** Nudge avatars that land on top of each other at the current zoom. Positions stay true. */
  function spreadPins() {
    const m = map.current;
    if (!m) return;
    const z = m.getZoom() ?? SINGLE_ZOOM;
    const list = pinsRef.current.filter((p) => markers.current.has(p.id));
    const off = spreadOverlaps(list.map((p) => worldPx(p.lat, p.lng, z)), PIN_GAP_PX);
    list.forEach((p, i) => {
      const content = markers.current.get(p.id)?.content as HTMLElement | undefined;
      if (content) content.style.transform = off[i].x || off[i].y ? `translate(${off[i].x.toFixed(1)}px, ${off[i].y.toFixed(1)}px)` : '';
    });
  }

  /** Centre on the middle of the group and zoom so everyone fits, down to the imagery limit. */
  function fitGroup(list: MapPin[]) {
    const m = map.current;
    if (!m || !el.current) return;
    fitting.current = true;
    // 'idle' clears it; if the view didn't change, no 'idle' comes, so clear it anyway.
    window.setTimeout(() => (fitting.current = false), 1_000);
    const w = el.current.clientWidth;
    const h = el.current.clientHeight;
    if (list.length === 0) {
      m.setCenter(center);
      m.setZoom(zoomForSpan(SINGLE_SPAN_M, SINGLE_SPAN_M, w, h, center.lat, maxZoom.current));
      return;
    }
    const lats = list.map((p) => p.lat);
    const lngs = list.map((p) => p.lng);
    const mid = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
    const spanY = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG;
    const spanX = (Math.max(...lngs) - Math.min(...lngs)) * M_PER_DEG * Math.cos((mid.lat * Math.PI) / 180);
    // The zoom follows the map's real size: a small map zooms out further for the same group.
    const zoom =
      list.length === 1
        ? zoomForSpan(SINGLE_SPAN_M, SINGLE_SPAN_M, w, h, mid.lat, maxZoom.current)
        : zoomForSpan(spanX, spanY, w, h, mid.lat, maxZoom.current);
    m.setCenter(mid);
    m.setZoom(zoom);
  }

  useEffect(() => {
    let alive = true;
    const fail = () => alive && failRef.current();
    if (authFailed) {
      fail();
      return;
    }
    authListeners.add(fail);
    loadGoogleMaps()
      .then(() => {
        if (!alive || !el.current) return;
        const g = window.google;
        map.current = new g.maps.Map(el.current, {
          center,
          zoom: 19,
          mapId: MAP_ID,
          mapTypeId: 'hybrid',
          disableDefaultUI: true,
          zoomControl: true,
          rotateControl: true,
          fullscreenControl: true,
          gestureHandling: 'cooperative',
          clickableIcons: false,
          // The attribution, Terms and error-report links are required by Google and stay.
          keyboardShortcuts: false,
        });
        const m = map.current;
        m.addListener('dragstart', () => (userMoved.current = true));
        m.addListener('zoom_changed', () => {
          if (!fitting.current) userMoved.current = true;
          spreadPins();
        });
        m.addListener('idle', () => (fitting.current = false));
        try {
          new g.maps.MaxZoomService().getMaxZoomAtLatLng(center, (r: { status: string; zoom: number }) => {
            if (r?.status === 'OK' && r.zoom) maxZoom.current = Math.min(r.zoom, HARD_MAX_ZOOM);
          });
        } catch {
          // Unknown: keep the default.
        }
        setReady(true);
      })
      .catch(fail);
    return () => {
      alive = false;
      authListeners.delete(fail);
      // The map and its markers go with the element; detaching them one by one can throw once it's gone.
      markers.current.clear();
      map.current = null;
    };
    // The map is created once; later centre changes come through fitting below.
  }, []);

  // The resize observer outlives renders; give it the latest fit, not the first one.
  const fitRef = useRef(fitGroup);
  fitRef.current = fitGroup;
  const spreadRef = useRef(spreadPins);
  spreadRef.current = spreadPins;

  // Re-fit when the map changes size (window resize, rotation, fullscreen), unless the person moved it.
  useEffect(() => {
    const node = el.current;
    if (!ready || !node) return;
    let last = { w: node.clientWidth, h: node.clientHeight };
    let timer = 0;
    const ro = new ResizeObserver(() => {
      const w = node.clientWidth;
      const h = node.clientHeight;
      // Ignore sub-pixel jitter; wait for a resize drag to settle.
      if (Math.abs(w - last.w) < 8 && Math.abs(h - last.h) < 8) return;
      last = { w, h };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!userMoved.current) fitRef.current(pinsRef.current);
        spreadRef.current();
      }, 150);
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [ready]);

  // Add, move and remove markers in place so the map doesn't flicker on every poll.
  useEffect(() => {
    const m = map.current;
    const g = window.google;
    if (!ready || !m || !g?.maps?.marker) return;
    const keep = new Set(pins.map((p) => p.id));
    for (const [id, marker] of markers.current) {
      if (!keep.has(id)) {
        try {
          marker.map = null;
        } catch {
          // Already detached.
        }
        markers.current.delete(id);
      }
    }
    for (const pin of pins) {
      const existing = markers.current.get(pin.id);
      if (existing) {
        existing.position = { lat: pin.lat, lng: pin.lng };
        existing.title = pin.title;
        updatePinElement(existing.content, pin);
      } else {
        markers.current.set(
          pin.id,
          new g.maps.marker.AdvancedMarkerElement({ map: m, position: { lat: pin.lat, lng: pin.lng }, title: pin.title, content: pinElement(pin) }),
        );
      }
    }
    // Re-frame when who is on the map or the venue changes. Between those, only
    // when someone walks out of view, and never after the person has moved the map.
    const key = `${pins.map((p) => p.id).sort().join(',')}@${center.lat},${center.lng}`;
    if (key !== fitted.current) {
      fitted.current = key;
      userMoved.current = false;
      fitGroup(pins);
    } else if (!userMoved.current) {
      const bounds = m.getBounds();
      if (bounds && pins.some((p) => !bounds.contains({ lat: p.lat, lng: p.lng }))) fitGroup(pins);
    }
    spreadPins();
  }, [pins, ready, center]);

  return <div ref={el} className="map map-google" />;
}
