import { useEffect, useState } from 'react';
import { googleMapsConfigured, loadGoogleMaps } from './components/GoogleMap';

/**
 * The demo venue: where simulated people are drawn on the group map. Real
 * phone fixes always show where they really are. A public place (a club, a
 * hall), never someone's home.
 */
export interface Venue {
  label: string;
  lat: number;
  lng: number;
}

const KEY = 'ytc.demoVenue';
const CHANGED = 'ytc-venue-changed';

/** Toronto City Hall, unless the build sets DEMO_VENUE ("lat,lng" or "lat,lng|Name"). */
export const DEFAULT_VENUE: Venue = parseVenueEnv(import.meta.env.DEMO_VENUE) ?? {
  label: 'Toronto City Hall',
  lat: 43.6532,
  lng: -79.3832,
};

function parseVenueEnv(raw: string | undefined): Venue | null {
  if (!raw?.trim()) return null;
  const [coords, label] = raw.split('|');
  const c = parseCoordinates(coords);
  return c ? { ...c, label: label?.trim() || 'Demo venue' } : null;
}

/**
 * "43.6532, -79.3832", or a Google Maps link containing "@43.6532,-79.3832".
 * Returns null for anything else.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  // The whole input is a coordinate pair, or a link carries one after "@". "Unit 5, 123 King St" is an address.
  const m = text.match(new RegExp(`^\\s*${num}\\s*,\\s*${num}\\s*$`)) ?? text.match(new RegExp(`@${num},${num}`));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function read(): Venue {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Venue | null;
    if (v && typeof v.lat === 'number' && typeof v.lng === 'number' && typeof v.label === 'string') return v;
  } catch {
    // A missing or unreadable setting means the default venue.
  }
  return DEFAULT_VENUE;
}

/** Saved in this browser only, as a presenter convenience. `null` goes back to the default. */
export function setDemoVenue(v: Venue | null): void {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the change lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: v ?? DEFAULT_VENUE }));
}

export function useDemoVenue(): Venue {
  const [venue, setVenue] = useState(read);
  useEffect(() => {
    const onChange = (e: Event) => setVenue((e as CustomEvent<Venue>).detail ?? read());
    const onStorage = (e: StorageEvent) => e.key === KEY && setVenue(read());
    window.addEventListener(CHANGED, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return venue;
}

/**
 * Turns what the presenter typed into a venue: coordinates directly, an
 * address through Google's geocoder. Returns an error message on failure.
 */
export async function resolveVenue(text: string): Promise<Venue | string> {
  const input = text.trim();
  if (!input) return 'Enter an address or coordinates.';
  const coords = parseCoordinates(input);
  if (coords) return { ...coords, label: input.length <= 40 ? input : 'Demo venue' };
  if (!googleMapsConfigured) return 'Looking up an address needs a Google Maps key. Paste coordinates instead.';
  try {
    await loadGoogleMaps();
    const { Geocoder } = await window.google.maps.importLibrary('geocoding');
    const { results } = await new Geocoder().geocode({ address: input });
    const first = results?.[0];
    if (!first) return 'No place found for that address.';
    const loc = first.geometry.location;
    return { lat: loc.lat(), lng: loc.lng(), label: first.formatted_address ?? input };
  } catch (err) {
    const code = String((err as { code?: string })?.code ?? '');
    if (code === 'ZERO_RESULTS') return 'No place found for that address.';
    if (code === 'REQUEST_DENIED') return 'Address lookup is off for this Maps key. Enable the Geocoding API, or paste coordinates.';
    return "Couldn't look up that address. Paste coordinates instead.";
  }
}
