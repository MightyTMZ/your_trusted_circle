import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { activeIncidentFor } from '../../domain/incident';
import { participantUpdate } from '../../domain/session';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { useFirstContact } from './HelpSheet';
import { Icon } from './Icon';
import { useLive } from '../hooks/useServerSession';
import { sendImOkOnServer } from '../api';

/**
 * Full-screen blocking overlay shown to a participant who has an open alert
 * about them. Portalled to <body> at z-index 200 so it sits above everything
 * including the tab bar and sheets. The only interactive element is the
 * "Tell responders I'm OK" button.
 */
export function AlertOverlay() {
  const { state, me } = useApp();
  const session = state.session;
  if (!session || !me) return null;
  const myIncident = activeIncidentFor(state, me.id);
  if (!myIncident) return null;

  return <AlertOverlayInner key={myIncident.id} />;
}

function AlertOverlayInner() {
  const { state, me, store } = useApp();
  const session = state.session!;
  const viewer = me!;
  const isHost = viewer.id === session.hostId;
  const myIncident = activeIncidentFor(state, viewer.id)!;
  const firstContact = useFirstContact();
  const live = useLive();

  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset sent state if the incident changes.
  const prevId = useRef(myIncident.id);
  useEffect(() => {
    if (myIncident.id !== prevId.current) {
      prevId.current = myIncident.id;
      setSent(false);
    }
  }, [myIncident.id]);

  const sendImOk = async () => {
    if (busy || sent) return;
    setBusy(true);
    if (!myIncident.server || !session.serverId) {
      store.dispatch((d, t) => participantUpdate(d, viewer.id, t));
      setSent(true);
      setBusy(false);
      return;
    }
    const r = await sendImOkOnServer(session.serverId);
    setBusy(false);
    if (r.ok) {
      setSent(true);
      await live.refreshAlerts();
    } else {
      setError(r.message);
    }
  };

  return createPortal(
    <div className="alert-overlay" role="alertdialog" aria-modal="true" aria-labelledby="alert-overlay-title">
      <div className="alert-overlay-card">
        <span className="alert-overlay-icon" aria-hidden="true">
          <Icon name="alert" />
        </span>
        <h2 id="alert-overlay-title" className="t-title">
          An alert about you is open
        </h2>
        <p className="t-sub num" style={{ maxWidth: 320 }}>
          {myIncident.acknowledged
            ? `${myIncident.acknowledged.name} acknowledged at ${fmtTime(myIncident.acknowledged.at)} and is responding.`
            : `${firstContact[0].toUpperCase()}${firstContact.slice(1)} ${isHost ? 'were' : 'was'} alerted at ${fmtTime(myIncident.openedAt)}.`}{' '}
          Only a recipient can resolve it.
        </p>
        {sent ? (
          <p className="t-body" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="check" /> Sent — responders can see you responded
          </p>
        ) : (
          <button type="button" className={`btn pbtn on-danger${busy ? ' btn-sent' : ''}`} disabled={busy} onClick={sendImOk}>
            {busy ? 'Sending…' : "Tell responders I'm OK"}
          </button>
        )}
        <span className="t-cap">This adds to the alert record. It does not close the alert.</span>
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
