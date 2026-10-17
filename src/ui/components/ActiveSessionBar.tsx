import { useState } from 'react';
import { leaveSession } from '../../domain/session';
import { COPY, SHARING_LABEL } from '../copy';
import { useApp, useNow } from '../context';
import { fmtRemaining } from '../format';
import { Sheet } from './Sheet';

/** Visible on every screen while this device is part of a session. */
export function ActiveSessionBar() {
  const { state, me, meRecipient, store, setViewer } = useApp();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = state.session;

  if (meRecipient) {
    return (
      <div className="session-bar" role="status">
        <span className="dot hollow" />
        <div className="meta">
          <div className="line1">{meRecipient.name}</div>
          <div className="line2">Simulated recipient. You see only what was sent to you.</div>
        </div>
        <button className="btn btn-ghost" onClick={() => setViewer(null)}>
          Exit
        </button>
      </div>
    );
  }

  if (!session || !me) return null;

  const isHost = me.id === session.hostId;
  const ended = session.status === 'ended' || me.status === 'left';
  const suspended = session.status === 'suspended';

  const line1 = ended
    ? me.status === 'left'
      ? 'You left this session'
      : session.endedReason === 'expired'
        ? 'Session expired'
        : 'Session ended by host'
    : suspended
      ? `Session suspended by host · ${session.name}`
      : `Session active · ${session.name}`;

  const line2 = ended
    ? 'Nothing is being shared.'
    : [
        isHost ? 'You are the host' : `Host: ${state.participants[session.hostId]?.displayName ?? 'unknown'}`,
        `Location: ${SHARING_LABEL[me.consent.locationSharing]}`,
        `Check-ins: ${me.consent.motionMonitoring ? (suspended ? 'Paused' : 'On') : 'Off'}`,
        fmtRemaining(session.expiresAt - now),
      ]
        .filter(Boolean)
        .join(' · ');

  const onLeave = () => {
    const err = store.dispatch((d, t) => leaveSession(d, me.id, t));
    if (err) return setError(err);
    setConfirming(false);
    setViewer(null);
  };

  return (
    <>
      <div className="session-bar" role="status" aria-live="polite">
        <span className={`dot ${ended ? '' : suspended ? 'attention' : 'live'}`} aria-hidden />
        <div className="meta">
          <div className="line1">{line1}</div>
          <div className="line2">{line2}</div>
        </div>
        {ended ? (
          <button className="btn btn-ghost" onClick={() => setViewer(null)}>
            Done
          </button>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirming(true)}>
            {COPY.leaveSession}
          </button>
        )}
      </div>
      {confirming && (
        <Sheet onClose={() => setConfirming(false)}>
          <h2 className="h2">{isHost ? 'End the session for everyone?' : 'Leave this session?'}</h2>
          <p className="lead">{isHost ? COPY.leaveConfirmHost : COPY.leaveConfirmParticipant}</p>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-block" onClick={onLeave}>
            {isHost ? 'End session' : COPY.leaveSession}
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => setConfirming(false)}>
            Stay
          </button>
        </Sheet>
      )}
    </>
  );
}
