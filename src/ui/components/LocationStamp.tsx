import { describeOffset, type Freshness } from '../../domain/location';
import type { LocationReading } from '../../domain/types';
import { fmtAgo, fmtTime } from '../format';

/**
 * Every location carries its timestamp. Only the latest, recent reading is
 * "Live"; anything else is labelled "Stale" with its last-known time.
 */
export function LocationStamp({
  reading,
  fresh,
  now,
  showPlace = true,
}: {
  reading: LocationReading;
  fresh: Freshness;
  now: number;
  showPlace?: boolean;
}) {
  return (
    <span className="stack" style={{ gap: 2 }}>
      <span className="inline t-sub num" style={{ gap: 6 }}>
        <span className={`dot ${fresh === 'live' ? 'live' : 'hollow'}`} aria-hidden="true" />
        {fresh === 'live' ? (
          <span>
            <span className="t-name" style={{ fontSize: 12 }}>
              Live
            </span>{' '}
            · {fmtTime(reading.recordedAt)}
          </span>
        ) : (
          <span>
            <span className="t-name" style={{ fontSize: 12 }}>
              Stale
            </span>{' '}
            · last known {fmtTime(reading.recordedAt)} · {fmtAgo(now - reading.recordedAt)}
          </span>
        )}
      </span>
      {showPlace && (
        <span className="t-cap">
          {describeOffset(reading)} · ±{reading.accuracyM} m · synthetic
        </span>
      )}
    </span>
  );
}
