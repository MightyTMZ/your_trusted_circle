import { respondToCheckIn } from '../../domain/session';
import type { CheckIn } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtCountdown, fmtTime } from '../format';

/** Private: rendered only on the participant's own device. The host never sees pending check-ins. */
export function ParticipantCheckInScreen({ checkIn }: { checkIn: CheckIn }) {
  const { store, me, state } = useApp();
  const now = useNow();
  const remaining = checkIn.dueAt - now;
  const isHost = me!.id === state.session?.hostId;
  const hostName = state.session ? state.participants[state.session.hostId]?.displayName : undefined;
  const backups = me!.backupContacts.map((c) => c.name).join(', ');
  // Name the person who will be alerted, so the deadline has a face.
  const whoIsAlerted = isHost
    ? backups
      ? `your backup contacts (${backups}) are`
      : 'your backup contacts are'
    : hostName
      ? `${hostName} (your host) is`
      : 'your host is';
  const respond = (r: 'ok' | 'help') => store.dispatch((d, t) => respondToCheckIn(d, me!.id, checkIn.id, r, t));

  return (
    <div className="screen checkin">
      <div className="stack">
        <span className="eyebrow">{COPY.checkInTitle}</span>
        <span className="small">{COPY.checkInPrivacy}</span>
      </div>

      <div className="stack-lg">
        <p className="lead">
          {COPY.movementChanged} at <span className="mono">{fmtTime(checkIn.promptedAt)}</span>.
        </p>
        <h1 className="question">Are you OK?</h1>
        <div className="stack" style={{ gap: 2 }}>
          <span className="countdown" aria-live="polite">
            {fmtCountdown(remaining)}
          </span>
          <span className="small">
            If you don't answer, {whoIsAlerted} alerted at <span className="mono">{fmtTime(checkIn.dueAt)}</span>.
          </span>
        </div>
      </div>

      <div className="screen-footer">
        <button className="btn btn-primary btn-block btn-large" onClick={() => respond('ok')}>
          {COPY.checkInOk}
        </button>
        <button className="btn btn-critical btn-block btn-large" onClick={() => respond('help')}>
          {COPY.checkInHelp}
        </button>
        <p className="tiny">{COPY.observationNotDiagnosis}</p>
      </div>
    </div>
  );
}
