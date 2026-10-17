import { useState } from 'react';
import { respondToCheckIn } from '../../domain/session';
import type { CheckIn } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtCountdown, fmtTime } from '../format';
import { ArcGauge } from '../components/Gauges';
import { respondToCheckInOnServer } from '../api';

const hm = (t: number) => fmtTime(t).slice(0, 5);

/** Private: rendered only on the participant's own device. The host never sees pending check-ins. */
export function ParticipantCheckInScreen({ checkIn }: { checkIn: CheckIn }) {
  const { store, me, state } = useApp();
  const now = useNow();
  const [sending, setSending] = useState(false);
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

  const respond = async (r: 'ok' | 'help') => {
    setSending(true);
    // Update local state immediately for responsive UI.
    store.dispatch((d, t) => respondToCheckIn(d, me!.id, checkIn.id, r, t));

    // Persist to MongoDB via the server.
    if (checkIn.serverId) {
      await respondToCheckInOnServer(checkIn.serverId, r).catch(() => {});
    }
    setSending(false);
  };

  return (
    <div className="screen">
      <div className="narrow">
        <div className="spread">
          <span className="tag">{COPY.checkInTitle}</span>
          <span className="t-sub">{COPY.checkInPrivacy}</span>
        </div>
        <div className="stack center rise" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
          <h1 className="t-display">Are you OK?</h1>
          <p className="t-lead num">
            {COPY.movementChanged} at {fmtTime(checkIn.promptedAt)}.
          </p>
        </div>
        <ArcGauge
          progress={(now - checkIn.promptedAt) / (checkIn.dueAt - checkIn.promptedAt)}
          label="Respond within"
          value={fmtCountdown(remaining)}
          startLabel={hm(checkIn.promptedAt)}
          endLabel={hm(checkIn.dueAt)}
          ariaLabel={`${fmtCountdown(remaining)} left to respond.`}
          role="timer"
        />
        <p className="t-sub center num" aria-live="polite">
          If you don't answer, {whoIsAlerted} alerted at {fmtTime(checkIn.dueAt)}.
        </p>
        <div className="screen-footer">
          <button type="button" className="btn pbtn on-accent" disabled={sending} onClick={() => respond('ok')}>
            {COPY.checkInOk}
          </button>
          <button type="button" className="btn pbtn outline-accent" disabled={sending} onClick={() => respond('help')}>
            {COPY.checkInHelp}
          </button>
          <p className="t-cap center">{COPY.observationNotDiagnosis}</p>
        </div>
      </div>
    </div>
  );
}
