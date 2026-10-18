import { useState } from 'react';
import { leaveSession } from '../../domain/session';
import { endSessionOnServer, leaveSessionOnServer } from '../api';
import { COPY, SHARING_LABEL } from '../copy';
import { useApp, useNow } from '../context';
import { fmtRemaining } from '../format';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/**
 * The active-session indicator. It lives in the navigation, not as a banner:
 * a pill above the tab bar on phones (like a tab bar accessory) and a block in
 * the sidebar on larger screens. Tapping it opens the session details, where
 * people can leave (or, as host, end the session).
 */
export function SessionStatus({ variant }: { variant: 'accessory' | 'sidebar' }) {
  const { state, me } = useApp();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const session = state.session;
  if (!session || !me || session.status === 'ended' || me.status !== 'active') return null;
  const suspended = session.status === 'suspended';
  const status = suspended ? 'Suspended' : fmtRemaining(session.expiresAt - now);
  return (
    <>
      <button
        type="button"
        className={`btn ${variant === 'accessory' ? 'material session-accessory' : 'session-side'}`}
        aria-haspopup="dialog"
        aria-label={`Session ${suspended ? 'suspended' : 'active'}: ${session.name}, ${status}. Show details.`}
        onClick={() => setOpen(true)}
      >
        <span className={`dot ${suspended ? 'hollow' : 'live'}`} aria-hidden="true" />
        <span className="session-name">{session.name}</span>
        <span className="session-meta num">{status}</span>
        <span className="chev" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      {open && <SessionSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/** Session details, then a confirm step before leaving or ending. One sheet, two steps. */
function SessionSheet({ onClose }: { onClose(): void }) {
  const { state, me, store, setViewer } = useApp();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = state.session!;
  const isHost = me!.id === session.hostId;
  const suspended = session.status === 'suspended';

  const onLeave = () => {
    const err = store.dispatch((d, t) => leaveSession(d, me!.id, t));
    if (err) return setError(err);
    if (session.serverId) (isHost ? endSessionOnServer : leaveSessionOnServer)(session.serverId);
    onClose();
    setViewer(null);
  };

  if (confirming) {
    return (
      <Sheet title={isHost ? 'End the session for everyone?' : 'Leave this session?'} onClose={onClose}>
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
    );
  }

  return (
    <Sheet title={session.name} onClose={onClose}>
      <dl className="session-facts">
        <div className="kv">
          <dt>Status</dt>
          <dd className="num">{suspended ? 'Suspended' : `Active · ${fmtRemaining(session.expiresAt - now)}`}</dd>
        </div>
        <div className="kv">
          <dt>Host</dt>
          <dd>{isHost ? 'You' : (state.participants[session.hostId]?.displayName ?? 'Unknown')}</dd>
        </div>
        <div className="kv">
          <dt>Your location</dt>
          <dd>{SHARING_LABEL[me!.consent.locationSharing]}</dd>
        </div>
        <div className="kv">
          <dt>Your check-ins</dt>
          <dd>{me!.consent.motionMonitoring ? (suspended ? 'Paused' : 'On') : 'Off'}</dd>
        </div>
      </dl>
      <button type="button" className="btn pbtn fill" onClick={() => setConfirming(true)}>
        <Icon name="logOut" />
        {isHost ? 'End session' : COPY.leaveSession}
      </button>
      <button type="button" className="btn pbtn fill" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}
