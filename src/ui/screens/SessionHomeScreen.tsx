import { useState } from 'react';
import { UNVALIDATED_LABEL } from '../../domain/config';
import { activeIncidentFor, nextDeadline } from '../../domain/incident';
import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import { endSession, participantUpdate, requestHelp, resumeSession, suspendSession } from '../../domain/session';
import type { Incident, Participant } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtAgo, fmtCountdown, fmtTime } from '../format';
import { GroupMap } from '../components/GroupMap';
import { LocationStamp } from '../components/LocationStamp';
import { Sheet } from '../components/Sheet';

function AlertRow({ incident, now }: { incident: Incident; now: number }) {
  const { state, go } = useApp();
  const p = state.participants[incident.participantId];
  const deadline = nextDeadline(incident);
  const status =
    incident.status === 'open'
      ? deadline !== undefined
        ? `Unacknowledged · escalates in ${fmtCountdown(deadline - now)}`
        : 'Unacknowledged · all steps alerted'
      : incident.status === 'acknowledged'
        ? `Acknowledged by ${incident.acknowledged?.name} · not yet resolved`
        : `Resolved ${fmtTime(incident.resolution!.at)}`;
  return (
    <div className="list-row clickable" onClick={() => go({ name: 'alert', id: incident.id })}>
      <span className={`dot ${incident.status === 'open' ? 'attention' : 'hollow'}`} style={{ marginTop: 7 }} />
      <div className="grow stack" style={{ gap: 2 }}>
        <span style={{ fontWeight: 600 }}>
          {incident.trigger === 'help_requested' ? `${p.displayName} asked for help` : `${COPY.movementChanged} · ${p.displayName}`}
        </span>
        <span className="small">{status}</span>
      </div>
      <span className="chev">›</span>
    </div>
  );
}

function RosterRow({ subject, viewer, now }: { subject: Participant; viewer: Participant; now: number }) {
  const { state } = useApp();
  const session = state.session!;
  const isHostView = viewer.id === session.hostId;
  const reading = latestReading(subject);
  const visible = canViewLocation(session, viewer, subject);

  let location;
  if (subject.consent.locationSharing === 'off') location = <span className="small">{COPY.locationOff}</span>;
  else if (!visible) location = <span className="small">{COPY.locationNotShared}</span>;
  else if (!reading) location = <span className="small">{COPY.locationNone}</span>;
  else
    location = (
      <LocationStamp
        reading={reading}
        fresh={participantFreshness(subject, reading, now, session.config.locationStaleAfterSec)}
        now={now}
      />
    );

  return (
    <div className="list-row">
      <div className="grow stack" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{subject.id === viewer.id ? `${subject.displayName} (you)` : subject.displayName}</span>
          {subject.role === 'host' && <span className="tag">Host</span>}
          {!subject.device.online && <span className="tag">Offline {fmtAgo(now - subject.device.changedAt)}</span>}
        </div>
        {location}
        {isHostView && subject.id !== viewer.id && (
          <span className="tiny">Check-ins {subject.consent.motionMonitoring ? 'on' : 'off'} (their choice)</span>
        )}
      </div>
    </div>
  );
}

function MonitoringPanel({ me }: { me: Participant }) {
  const { state, go } = useApp();
  const session = state.session!;
  const b = me.baseline;
  const d = session.config.detector;
  return (
    <section className="stack">
      <div className="spread">
        <h2 className="h2">Your check-ins</h2>
        <button className="link small" onClick={() => go({ name: 'sharing' })}>
          Sharing settings
        </button>
      </div>
      {!me.consent.motionMonitoring ? (
        <p className="small">Movement check-ins are off. You can turn them on in sharing settings.</p>
      ) : session.status === 'suspended' ? (
        <p className="small">Paused while the host has the session suspended.</p>
      ) : b.status === 'calibrating' ? (
        <p className="small">
          Learning your usual movement · <span className="mono">{b.n}/{d.calibrationSamples}</span> samples. Keep your phone on you.
        </p>
      ) : b.status === 'calibrated' ? (
        <div className="stack" style={{ gap: 2 }}>
          <p className="small">
            Baseline set at <span className="mono">{fmtTime(b.calibratedAt!)}</span> · typical{' '}
            <span className="mono">{b.mean!.toFixed(2)} ± {b.std!.toFixed(2)} m/s²</span>
          </p>
          <p className="tiny">
            Rule: |z| ≥ {d.zThreshold} for {d.consecutiveSamples} samples in a row. {UNVALIDATED_LABEL}.
          </p>
        </div>
      ) : (
        <p className="small">No baseline yet.</p>
      )}
    </section>
  );
}

export function SessionHomeScreen() {
  const { state, me, store, go } = useApp();
  const now = useNow();
  const [sheet, setSheet] = useState<null | 'end' | 'help'>(null);
  const [error, setError] = useState<string | null>(null);
  const session = state.session!;
  const viewer = me!;
  const isHost = viewer.id === session.hostId;
  const ended = session.status === 'ended' || viewer.status === 'left';

  const others = Object.values(state.participants).filter((p) => p.status === 'active');
  const alerts = state.incidents
    .filter((i) => i.participantId !== viewer.id)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.openedAt - a.openedAt);
  const myIncident = activeIncidentFor(state, viewer.id);

  const run = (fn: Parameters<typeof store.dispatch>[0]) => {
    const err = store.dispatch(fn);
    setError(err);
    return !err;
  };

  if (ended) {
    return (
      <div className="screen">
        <div className="stack">
          <span className="eyebrow">{session.name}</span>
          <h1 className="title">{viewer.status === 'left' ? 'You left the session' : 'This session has ended'}</h1>
          <p className="lead">Location sharing and check-ins have stopped.</p>
        </div>
        {isHost && alerts.length > 0 && (
          <section className="stack">
            <h2 className="h2">Alerts from this session</h2>
            <div className="list">
              {alerts.map((i) => (
                <AlertRow key={i.id} incident={i} now={now} />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="screen">
      {myIncident && (
        <section className="panel panel-attention">
          <h2 className="h2">An alert about you is open</h2>
          <p className="small">
            {myIncident.acknowledged
              ? `${myIncident.acknowledged.name} acknowledged at ${fmtTime(myIncident.acknowledged.at)} and is responding.`
              : `Your host was alerted at ${fmtTime(myIncident.openedAt)}.`}{' '}
            Only a recipient can resolve it.
          </p>
          <button className="btn btn-secondary btn-block" onClick={() => run((d, t) => participantUpdate(d, viewer.id, t))}>
            Tell responders I'm OK
          </button>
          <span className="tiny">This is added to the alert's record. It does not close the alert.</span>
        </section>
      )}

      {isHost && (
        <section className="stack">
          <div className="spread">
            <h2 className="h2">Alerts</h2>
            {session.status === 'suspended' && <span className="tag tag-attention">Suspended</span>}
          </div>
          {alerts.length === 0 ? (
            <p className="small">No alerts. You'll be notified here first if someone misses a check-in or asks for help.</p>
          ) : (
            <div className="list">
              {alerts.map((i) => (
                <AlertRow key={i.id} incident={i} now={now} />
              ))}
            </div>
          )}
        </section>
      )}

      {isHost && (
        <section className="stack">
          <h2 className="h2">Host controls</h2>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => go({ name: 'invite' })}>
              Show QR code
            </button>
            {session.status === 'active' ? (
              <button className="btn btn-secondary" onClick={() => run((d, t) => suspendSession(d, viewer.id, t))}>
                Suspend session
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => run((d) => resumeSession(d, viewer.id))}>
                Resume session
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => setSheet('end')}>
              End session
            </button>
          </div>
          {session.status === 'suspended' && (
            <p className="tiny">
              Suspended: location updates and new check-ins are paused for everyone. Open alerts keep escalating.
            </p>
          )}
        </section>
      )}

      <section className="stack">
        <h2 className="h2">Group</h2>
        <GroupMap viewer={viewer} now={now} />
        <div className="list">
          {others.map((p) => (
            <RosterRow key={p.id} subject={p} viewer={viewer} now={now} />
          ))}
        </div>
        <p className="tiny">
          Locations older than {session.config.locationStaleAfterSec}s, or from an offline phone, are marked stale.
        </p>
      </section>

      <MonitoringPanel me={viewer} />

      <div className="screen-footer">
        {error && <p className="error">{error}</p>}
        {!myIncident && (
          <button className="btn btn-critical btn-block" onClick={() => setSheet('help')}>
            {COPY.checkInHelp}
          </button>
        )}
      </div>

      {sheet === 'help' && (
        <Sheet onClose={() => setSheet(null)}>
          <h2 className="h2">Alert {isHost ? 'your backup contacts' : 'your host'} now?</h2>
          <p className="lead">
            {isHost ? 'Your backup contacts' : 'Your host'} will be alerted right away. If nobody acknowledges, it escalates.
          </p>
          <button
            className="btn btn-attention btn-block"
            onClick={() => {
              if (run((d, t) => requestHelp(d, viewer.id, t))) setSheet(null);
            }}
          >
            Send alert
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => setSheet(null)}>
            Cancel
          </button>
        </Sheet>
      )}

      {sheet === 'end' && (
        <Sheet onClose={() => setSheet(null)}>
          <h2 className="h2">End the session for everyone?</h2>
          <p className="lead">Location sharing and check-ins stop for the whole group. Open alerts must be acknowledged first.</p>
          {error && <p className="error">{error}</p>}
          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              if (run((d, t) => endSession(d, viewer.id, t))) setSheet(null);
            }}
          >
            End session
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => setSheet(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
