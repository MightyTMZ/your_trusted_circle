import { Component, useEffect, useRef, useState, type ReactNode } from 'react';

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
  const tone = pin.tone === 'alert' ? 'on-accent' : pin.tone === 'live' ? 'fill' : 'stale';
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
  const [ready, setReady] = useState(false);
  const failRef = useRef(onFail);
  failRef.current = onFail;

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
    // Re-frame only when who is on the map or the venue changes, not on every position update.
    const key = `${pins.map((p) => p.id).sort().join(',')}@${center.lat},${center.lng}`;
    if (key === fitted.current) return;
    fitted.current = key;
    if (pins.length === 0) {
      m.setCenter(center);
      m.setZoom(19);
    } else if (pins.length === 1) {
      m.setCenter({ lat: pins[0].lat, lng: pins[0].lng });
      m.setZoom(19);
    } else {
      const b = new g.maps.LatLngBounds();
      pins.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
      m.fitBounds(b, 48);
      g.maps.event.addListenerOnce(m, 'idle', () => m.getZoom() > 19 && m.setZoom(19));
    }
  }, [pins, ready, center]);

  return <div ref={el} className="map map-google" />;
}
