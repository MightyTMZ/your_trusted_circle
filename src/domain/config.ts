import type { SessionConfig } from './types';

/**
 * Default thresholds and intervals. ALL VALUES ARE UNVALIDATED placeholders
 * chosen for a hackathon demo; none has been tested against real-world data.
 */
export const DEFAULT_CONFIG: SessionConfig = {
  durationMin: 240,
  checkInWindowSec: 60,
  hostAckWindowSec: 120,
  backupAckWindowSec: 180,
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

export const MAX_LOCATION_HISTORY = 20;
export const MAX_BACKUP_CONTACTS = 2;
