/**
 * Location rule: no coordinates or place data are stored for a participant
 * unless an incident about them is active on the server.
 *
 * Timeline events are schema-strict, so only `location.reported` (and any
 * future event marked sensitivity "location") can carry location; those are
 * dropped outright. Free-form traces (logs, actions, sensor and device data)
 * have location-like keys removed at any depth before they are stored.
 */
import type { ParticipantDoc } from "../types.js";

/** Compared after lower-casing and removing "_" and "-". */
const LOCATION_KEYS = new Set([
  "lat",
  "latitude",
  "lng",
  "lon",
  "long",
  "longitude",
  "coords",
  "coordinates",
  "geo",
  "geolocation",
  "geohash",
  "location",
  "lastknownlocation",
  "position",
  "gps",
  "altitude",
  "heading",
  "address",
  "place",
  "pluscode",
]);

export const MAX_DEPTH = 32;

export class TooDeepError extends Error {}

const isLocationKey = (key: string) => LOCATION_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));

/** Returns a copy without location-like keys, and how many were removed. */
export function stripLocation(value: unknown, depth = 0): { value: unknown; removed: number } {
  if (depth > MAX_DEPTH) throw new TooDeepError("Data is nested too deeply.");
  if (Array.isArray(value)) {
    let removed = 0;
    const out = value.map((item) => {
      const r = stripLocation(item, depth + 1);
      removed += r.removed;
      return r.value;
    });
    return { value: out, removed };
  }
  if (value !== null && typeof value === "object") {
    let removed = 0;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isLocationKey(key)) {
        removed++;
        continue;
      }
      const r = stripLocation(item, depth + 1);
      removed += r.removed;
      out[key] = r.value;
    }
    return { value: out, removed };
  }
  return { value, removed: 0 };
}

/**
 * Location for this participant may be stored only while an incident about
 * them is active (reported to and opened by the server, not yet resolved),
 * and only if they have not turned all location sharing off.
 */
export function mayStoreLocation(p: ParticipantDoc | undefined, hasActiveIncident: boolean): boolean {
  if (!p || !hasActiveIncident) return false;
  return p.consent.locationSharing !== "off" || p.consent.shareLocationWithResponders;
}
