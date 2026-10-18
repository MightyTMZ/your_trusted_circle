import type { SessionConfig } from './types';

/**
 * Default thresholds and intervals. ALL VALUES ARE UNVALIDATED placeholders
 * chosen for a hackathon demo; none has been tested against real-world data.
 */
export const DEFAULT_CONFIG: SessionConfig = {
  durationMin: 240,
  checkInWindowSec: 60,
  hostAckWindowSec: 60,
  backupAckWindowSec: 60,
  locationStaleAfterSec: 90,
  locationUpdateEverySec: 15,
  detector: {
    calibrationSamples: 30,
    zThreshold: 3,
    consecutiveSamples: 4,
    minStd: 0.15,
  },
};

export const UNVALIDATED_LABEL = 'Unvalidated demo value';

/** The shortest and longest a host may make a session, in minutes. The server mirrors these (src/server/config.ts). */
export const MIN_DURATION_MIN = 30;
export const MAX_DURATION_MIN = 24 * 60;

export const MAX_LOCATION_HISTORY = 20;
export const MAX_BACKUP_CONTACTS = 2;
