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
    <div className="stack" style={{ gap: 2 }}>
      <span className={`loc ${fresh}`}>
        <span className={`dot ${fresh === 'live' ? 'live' : 'hollow'}`} aria-hidden />
        {fresh === 'live' ? (
          <>
            <span className="state">Live</span>
            <span className="mono">· {fmtTime(reading.recordedAt)}</span>
          </>
        ) : (
          <>
            <span className="state">Stale</span>
            <span>
              · last known <span className="mono">{fmtTime(reading.recordedAt)}</span> · {fmtAgo(now - reading.recordedAt)}
            </span>
          </>
        )}
      </span>
      {showPlace && (
        <span className="tiny">
          {describeOffset(reading)} · ±{reading.accuracyM} m · synthetic
        </span>
      )}
    </div>
  );
}
