import { useState } from 'react';
import { UNVALIDATED_LABEL } from '../../domain/config';
import { cancelOwnAlertOnServer } from '../api';
import { EMERGENCY_SIM_RECIPIENT_ID, activeIncidentFor, alertedRecipientIds, nextDeadline } from '../../domain/incident';
import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import { cancelOwnAlert, endSession, resumeSession, suspendSession } from '../../domain/session';
import type { AppState, Incident, Participant } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtAgo, fmtCountdown, fmtTime } from '../format';
import { SettingsButton } from '../components/AppNav';
import { initials } from '../components/Controls';
import { Scrubber } from '../components/Gauges';
import { GroupMap } from '../components/GroupMap';
import { Icon } from '../components/Icon';
import { LocationStamp } from '../components/LocationStamp';
import { useFirstContact } from '../components/HelpSheet';
import { Sheet } from '../components/Sheet';
import { useMotionTracking } from '../hooks/useMotionTracking';

function fmtHM(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** Who has been sent an alert so far, by name. */
function alertedNames(state: AppState, incident: Incident): string {
  const names = alertedRecipientIds(incident).map((id) =>
    id === EMERGENCY_SIM_RECIPIENT_ID ? 'simulated emergency services' : (state.recipients[id]?.name ?? 'unknown'),
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? 'nobody yet');
}

function AlertCard({ incident, now }: { incident: Incident; now: number }) {
  const { state, go } = useApp();
  const p = state.participants[incident.participantId];
  const deadline = nextDeadline(incident);
  const open = incident.status === 'open';
  const status = open
    ? deadline !== undefined
      ? `Unacknowledged · escalates in ${fmtCountdown(deadline - now)}`
      : 'Unacknowledged · all steps alerted'
    : incident.status === 'acknowledged'
      ? `Acknowledged by ${incident.acknowledged?.name} · not yet resolved`
      : incident.resolution?.by === 'participant'
        ? `${COPY.cancelledBySelf(p.displayName)} · ${fmtTime(incident.resolution.at)}`
        : `Resolved ${fmtTime(incident.resolution!.at)}`;
  const title = incident.trigger === 'help_requested' ? `${p.displayName} asked for help` : `${COPY.movementChanged} · ${p.displayName}`;
  return (
    <section className="surface card rise" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span className={`av num ${open ? 'on-accent' : 'fill'}`}>{initials(p.displayName)}</span>
      <span className="stack grow">
        <h2 className="t-card">{title}</h2>
        <span className="t-sub num">{status}</span>
      </span>
      <button type="button" className="btn ibtn fill" aria-label={`Open alert: ${title}`} onClick={() => go({ name: 'alert', id: incident.id })}>
        <Icon name="arrowUpRight" />
      </button>
    </section>
  );
}

function PersonRow({ subject, viewer, now, alerting }: { subject: Participant; viewer: Participant; now: number; alerting: boolean }) {
  const { state } = useApp();
  const session = state.session!;
  const isHostView = viewer.id === session.hostId;
  const reading = latestReading(subject);
  const visible = canViewLocation(session, viewer, subject);
  let location;
  if (subject.consent.locationSharing === 'off') location = <span className="t-sub">{COPY.locationOff}</span>;
  else if (!visible) location = <span className="t-sub">{COPY.locationNotShared}</span>;
  else if (!reading) location = <span className="t-sub">{COPY.locationNone}</span>;
  else
    location = (
      <LocationStamp
        reading={reading}
        fresh={participantFreshness(subject, reading, now, session.config.locationStaleAfterSec)}
        now={now}
        showPlace={false}
      />
    );
  return (
    <li className="row" style={{ alignItems: 'flex-start' }}>
      <span className={`av num ${alerting ? 'on-accent' : 'fill'}`}>{initials(subject.displayName)}</span>
      <span className="stack grow" style={{ gap: 4 }}>
        <span className="inline">
          <span className="t-name">{subject.id === viewer.id ? `${subject.displayName} (you)` : subject.displayName}</span>
          {subject.role === 'host' && <span className="tag">Host</span>}
          {!subject.device.online && <span className="tag num">Offline {fmtAgo(now - subject.device.changedAt)}</span>}
        </span>
        {location}
        {isHostView && subject.id !== viewer.id && (
          <span className="t-cap">Check-ins {subject.consent.motionMonitoring ? 'on' : 'off'} (their choice)</span>
        )}
      </span>
    </li>
  );
}

function CheckInStatus({ me }: { me: Participant }) {
  const { state, go } = useApp();
  const session = state.session!;
  const b = me.baseline;
  const d = session.config.detector;
  const text = !me.consent.motionMonitoring
    ? 'Off. You can turn them on in your sharing.'
    : session.status === 'suspended'
      ? 'Paused while the host has the session suspended.'
      : b.status === 'calibrating'
        ? `Learning your usual movement · ${b.n}/${d.calibrationSamples} samples`
        : b.status === 'calibrated'
          ? `Baseline set at ${fmtTime(b.calibratedAt!)} · typical ${b.mean!.toFixed(2)} ± ${b.std!.toFixed(2)} m/s²`
          : 'No baseline yet.';
  return (
    <section className="surface card card-list rise rise-4">
      <button type="button" className="btn lrow" onClick={() => go({ name: 'sharing' })}>
        <span className="stack grow">
          <span className="t-name">Your check-ins</span>
          <span className="t-sub num">{text}</span>
          {b.status === 'calibrated' && me.consent.motionMonitoring && (
            <span className="t-cap num">
              Rule: |z| ≥ {d.zThreshold} for {d.consecutiveSamples} samples in a row. {UNVALIDATED_LABEL}.
            </span>
          )}
        </span>
        <span className="chev">
          <Icon name="chevronRight" />
        </span>
      </button>
    </section>
  );
}

export function SessionHomeScreen() {
  const { state, me, store, go, setViewer } = useApp();
  const now = useNow();
  const [sheet, setSheet] = useState<null | 'end' | 'cancel'>(null);
  const [error, setError] = useState<string | null>(null);
  const session = state.session!;
  const viewer = me!;
  const trackingActive = viewer.consent.motionMonitoring && session.status === 'active' && viewer.status === 'active';
  const { permissionState: motionPerm, requestPermission: requestMotion } = useMotionTracking(
    store,
    trackingActive ? viewer.id : null,
  );
  const isHost = viewer.id === session.hostId;
  const ended = session.status === 'ended' || viewer.status === 'left';
  const people = Object.values(state.participants).filter((p) => p.status === 'active');
  const alerts = state.incidents
    .filter((i) => i.participantId !== viewer.id)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.openedAt - a.openedAt);
  const alerting = new Set(state.incidents.filter((i) => i.status === 'open').map((i) => i.participantId));
  const myIncident = activeIncidentFor(state, viewer.id);
  // The alert this person most recently cancelled themselves, shown for ten minutes as a receipt.
  const myCancelled = myIncident
    ? undefined
    : state.incidents
        .filter((i) => i.participantId === viewer.id && i.resolution?.by === 'participant' && now - i.resolution.at < 10 * 60_000)
        .sort((a, b) => b.resolution!.at - a.resolution!.at)[0];
  const hostName = state.participants[session.hostId]?.displayName;
  const firstContact = useFirstContact();
  const run = (fn: Parameters<typeof store.dispatch>[0]) => {
    const err = store.dispatch(fn);
    setError(err);
    return !err;
  };
  const errorBox = error && (
    <p className="error" role="alert">
      <Icon name="alert" />
      {error}
    </p>
  );

  if (ended) {
    return (
      <div className="screen">
        <div className="narrow">
          <header className="stack">
            <span className="t-sub">{session.name}</span>
            <h1 className="t-title">{viewer.status === 'left' ? 'You left the session' : 'This session has ended'}</h1>
          </header>
          <p className="t-lead">Location sharing and check-ins have stopped.</p>
          {isHost && alerts.length > 0 && (
            <section className="col">
              <h2 className="lbl">Alerts from this session</h2>
              {alerts.map((i) => (
                <AlertCard key={i.id} incident={i} now={now} />
              ))}
            </section>
          )}
          <div className="screen-footer">
            <button type="button" className="btn pbtn on-accent" onClick={() => setViewer(null)}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  const elapsed = now - session.createdAt;
  const total = session.expiresAt - session.createdAt;
  const sharingCount = people.filter((p) => p.consent.locationSharing !== 'off').length;

  return (
    <div className="screen">
      <header className="header">
        <span className="logo fill phone-only" role="img" aria-label="YTC">
          YTC
        </span>
        <h1 className="t-title grow">{session.name}</h1>
        {isHost && (
          <button type="button" className="btn ibtn fill" aria-label="Show QR code" onClick={() => go({ name: 'invite' })}>
            <Icon name="qr" />
          </button>
        )}
        <SettingsButton />
      </header>

      {myIncident && (
        <section className="surface card stack rise" style={{ gap: 12 }} aria-labelledby="my-alert-h">
          <h2 className="t-card" id="my-alert-h">
            An alert about you is open
          </h2>
          <p className="t-sub num">
            {myIncident.acknowledged
              ? `${myIncident.acknowledged.name} acknowledged at ${fmtTime(myIncident.acknowledged.at)} and is responding.`
              : `${firstContact[0].toUpperCase()}${firstContact.slice(1)} ${isHost ? 'were' : 'was'} alerted at ${fmtTime(myIncident.openedAt)}.`}
            {state.voiceCalls[myIncident.id]?.status === 'connected' && ' A simulated emergency call is in progress.'}
          </p>
          <button type="button" className="btn pbtn on-accent" onClick={() => setSheet('cancel')}>
            {COPY.cancelAlert}
          </button>
          <span className="t-cap">Only you can cancel an alert about you.</span>
        </section>
      )}

      {myCancelled && (
        <section className="surface card stack rise" style={{ gap: 8 }} role="status">
          <h2 className="t-card num">You cancelled the alert at {fmtTime(myCancelled.resolution!.at)}</h2>
          <p className="t-sub">
            Escalation stopped. {alertedNames(state, myCancelled)} {alertedRecipientIds(myCancelled).length > 1 ? 'were' : 'was'} told it was a
            false alarm. If you need help, use the help button: that starts a new alert.
          </p>
        </section>
      )}

      {trackingActive && motionPerm === 'prompt' && (
        <section className="surface card stack rise" style={{ gap: 8 }}>
          <h2 className="t-card">Motion sensor needed</h2>
          <p className="t-sub">Allow access so check-ins can work. Your phone's motion data stays private and is only used to notice unusual movement changes.</p>
          <button type="button" className="btn pbtn on-accent" onClick={requestMotion}>
            Enable motion sensor
          </button>
        </section>
      )}
      {trackingActive && motionPerm === 'denied' && (
        <section className="surface card stack rise" style={{ gap: 8 }}>
          <p className="t-sub">Motion sensor access was denied. Check-ins based on movement won't work. You can change this in your browser settings.</p>
        </section>
      )}

      <div className="cols">
        <div className="col">
          {isHost && alerts.map((i) => <AlertCard key={i.id} incident={i} now={now} />)}
          <section className="surface card rise rise-2" style={{ padding: 8 }} aria-label="Group map">
            <div style={{ position: 'relative' }}>
              <GroupMap viewer={viewer} now={now} alerting={alerting} />
              <span className="material chip map-chip num">
                {sharingCount} of {people.length} sharing
              </span>
            </div>
            <div className="stack" style={{ gap: 12, padding: '16px 12px 8px' }}>
              <div className="spread">
                <span className="stack">
                  <span className="t-card">Session</span>
                  <span className="t-sub">{isHost ? "You're the host" : `Host: ${hostName ?? 'unknown'}`}</span>
                </span>
                {isHost && (
                  <span className="inline">
                    {session.status === 'active' ? (
                      <button type="button" className="btn chip fill" onClick={() => run((d, t) => suspendSession(d, viewer.id, t))}>
                        <Icon name="pause" />
                        Suspend
                      </button>
                    ) : (
                      <button type="button" className="btn chip fill" onClick={() => run((d) => resumeSession(d, viewer.id))}>
                        <Icon name="play" />
                        Resume
                      </button>
                    )}
                    <button type="button" className="btn chip fill" onClick={() => setSheet('end')}>
                      End
                    </button>
                  </span>
                )}
              </div>
              <Scrubber
                progress={elapsed / total}
                left={fmtHM(elapsed)}
                right={`−${fmtHM(session.expiresAt - now)}`}
                ariaLabel={`Session progress: ${fmtHM(elapsed)} elapsed, ${fmtHM(session.expiresAt - now)} remaining`}
              />
              {session.status === 'suspended' && (
                <p className="t-sub">Location updates and new check-ins are paused for everyone. Open alerts keep escalating.</p>
              )}
            </div>
          </section>
          {errorBox}
        </div>

        <div className="col">
          <section className="surface card card-list rise rise-3" aria-labelledby="people-h">
            <div className="card-head">
              <h2 className="t-card" id="people-h">
                People
              </h2>
              <span className="t-sub num">{people.length}</span>
            </div>
            <ul>
              {people.map((p) => (
                <PersonRow key={p.id} subject={p} viewer={viewer} now={now} alerting={alerting.has(p.id)} />
              ))}
            </ul>
          </section>
          <CheckInStatus me={viewer} />
        </div>
      </div>

      {sheet === 'cancel' && myIncident && (
        <Sheet title={COPY.cancelAlertTitle} onClose={() => setSheet(null)}>
          <p className="t-lead">
            Escalation stops now, and {alertedNames(state, myIncident)} will be told you cancelled it as a false alarm.
            {state.voiceCalls[myIncident.id]?.status === 'connected' && ' The simulated emergency call ends after the assistant relays this.'}
          </p>
          <p className="t-sub">{COPY.cancelAlertCaveat}</p>
          {errorBox}
          <button
            type="button"
            className="btn pbtn on-accent"
            onClick={() => {
              if (run((d, t) => cancelOwnAlert(d, viewer.id, t))) {
                setSheet(null);
                cancelOwnAlertOnServer(session.id).catch(() => {});
              }
            }}
          >
            {COPY.cancelAlertConfirm}
          </button>
          <button type="button" className="btn pbtn fill" onClick={() => setSheet(null)}>
            {COPY.cancelAlertKeep}
          </button>
        </Sheet>
      )}

      {sheet === 'end' && (
        <Sheet title="End the session for everyone?" onClose={() => setSheet(null)}>
          <p className="t-lead">Location sharing and check-ins stop for the whole group. Open alerts must be acknowledged first.</p>
          {errorBox}
          <button
            type="button"
            className="btn pbtn on-accent"
            onClick={() => {
              if (run((d, t) => endSession(d, viewer.id, t))) setSheet(null);
            }}
          >
            End session
          </button>
          <button type="button" className="btn pbtn fill" onClick={() => setSheet(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
