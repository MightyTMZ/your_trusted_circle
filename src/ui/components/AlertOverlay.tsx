import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { activeIncidentFor, alertedNames } from '../../domain/incident';
import { applyServerIncident } from '../../domain/serverAlerts';
import { cancelOwnAlert } from '../../domain/session';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { useFirstContact } from './HelpSheet';
import { Icon } from './Icon';
import { useLive } from '../hooks/useServerSession';
import { cancelOwnAlertOnServer } from '../api';

/**
 * full-screen blocking overlay shown to a participant who has an open alert
 * about them. the main action is cancelling the alert as a false alarm,
 * confirmed here because a sheet would sit underneath
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

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset sent state if the incident changes.
  const prevId = useRef(myIncident.id);
  useEffect(() => {
    if (myIncident.id !== prevId.current) {
      prevId.current = myIncident.id;
      setConfirming(false);
    }
  }, [myIncident.id]);

  const cancelAlert = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (!myIncident.server || !session.serverId) {
      setError(store.dispatch((d, t) => void cancelOwnAlert(d, viewer.id, t)));
      setBusy(false);
      return;
    }
    // Server incidents: the server decides, and its answer replaces this device's copy.
    const r = await cancelOwnAlertOnServer(session.serverId);
    if (r.ok) store.dispatch((d) => void applyServerIncident(d, r.data.incident, viewer.id));
    else setError(r.message);
    await live.refreshAlerts();
    setBusy(false);
  };

  const callLive = state.voiceCalls[myIncident.id]?.status === 'connected';

  if (confirming) {
    return createPortal(
      <div className="alert-overlay" role="alertdialog" aria-modal="true" aria-labelledby="alert-overlay-title">
        <div className="alert-overlay-card">
          <h2 id="alert-overlay-title" className="t-title">
            {COPY.cancelAlertTitle}
          </h2>
          <p className="t-sub" style={{ maxWidth: 320 }}>
            Escalation stops now, and {alertedNames(state, myIncident)} will see that you cancelled it as a false alarm.
            {callLive && ' The simulated emergency call ends after the assistant relays this.'}
          </p>
          <span className="t-cap" style={{ maxWidth: 320 }}>
            {COPY.cancelAlertCaveat}
          </span>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className={`btn pbtn on-danger${busy ? ' btn-sent' : ''}`} disabled={busy} onClick={cancelAlert}>
            {busy ? 'Cancelling…' : COPY.cancelAlertConfirm}
          </button>
          <button type="button" className="btn pbtn fill" disabled={busy} onClick={() => setConfirming(false)}>
            {COPY.cancelAlertKeep}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

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
          {callLive && 'A simulated emergency call is in progress. '}
          If it's a false alarm, you can cancel it.
        </p>
        <button type="button" className="btn pbtn on-danger" onClick={() => setConfirming(true)}>
          {COPY.cancelAlert}
        </button>
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
