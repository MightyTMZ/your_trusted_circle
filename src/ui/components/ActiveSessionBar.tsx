import { useState } from 'react';
import { leaveSession } from '../../domain/session';
import { COPY, SHARING_LABEL } from '../copy';
import { useApp, useNow } from '../context';
import { fmtRemaining } from '../format';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** Visible on every screen while this device is part of a session. */
export function ActiveSessionBar() {
  const { state, me, meRecipient, store, setViewer } = useApp();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = state.session;
  // Recipients get their own header with an Exit button.
  if (meRecipient) return null;
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
      ? `Suspended · ${session.name}`
      : `Session active · ${session.name}`;
  const line2 = ended
    ? 'Nothing is being shared.'
    : [
        isHost ? 'You are the host' : `Host: ${state.participants[session.hostId]?.displayName ?? 'unknown'}`,
        `Location: ${SHARING_LABEL[me.consent.locationSharing]}`,
        `Check-ins: ${me.consent.motionMonitoring ? (suspended ? 'Paused' : 'On') : 'Off'}`,
        fmtRemaining(session.expiresAt - now),
      ].join(' · ');
  const onLeave = () => {
    const err = store.dispatch((d, t) => leaveSession(d, me.id, t));
    if (err) return setError(err);
    setConfirming(false);
    setViewer(null);
  };
  return (
    <>
      <div className="material session-bar" role="status" aria-live="polite">
        <span className={`dot ${ended ? '' : suspended ? 'hollow' : 'live'}`} aria-hidden="true" />
        <div className="meta">
          <div className="line1">{line1}</div>
          <div className="line2 num">{line2}</div>
        </div>
        {ended ? (
          <button type="button" className="btn chip fill" onClick={() => setViewer(null)}>
            Done
          </button>
        ) : (
          <button type="button" className="btn ibtn ibtn-sm fill" aria-label={isHost ? 'End session' : COPY.leaveSession} onClick={() => setConfirming(true)}>
            <Icon name="logOut" />
          </button>
        )}
      </div>
      {confirming && (
        <Sheet title={isHost ? 'End the session for everyone?' : 'Leave this session?'} onClose={() => setConfirming(false)}>
          <p className="t-lead">{isHost ? COPY.leaveConfirmHost : COPY.leaveConfirmParticipant}</p>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className="btn pbtn on-accent" onClick={onLeave}>
            {isHost ? 'End session' : COPY.leaveSession}
          </button>
          <button type="button" className="btn pbtn fill" onClick={() => setConfirming(false)}>
            Stay
          </button>
        </Sheet>
      )}
    </>
  );
}
