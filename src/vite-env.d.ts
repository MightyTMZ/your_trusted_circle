/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Browser key for the Maps JavaScript API. Without it the group map shows the synthetic venue plot. */
  readonly GOOGLE_MAPS_API_KEY?: string;
  /** Optional map ID for advanced markers. Defaults to Google's demo map ID. */
  readonly GOOGLE_MAPS_MAP_ID?: string;
  /** Default demo venue for simulated people: "lat,lng" or "lat,lng|Name". */
  readonly DEMO_VENUE?: string;
}
