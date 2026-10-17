/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Browser key for the Maps JavaScript API. Without it the group map shows the synthetic venue plot. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  /** Optional map ID for advanced markers. Defaults to Google's demo map ID. */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string;
}
