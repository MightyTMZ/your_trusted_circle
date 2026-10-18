import { useEffect, useRef, useState } from 'react';
import { GROUP_RECIPIENT_PREFIX, HOST_RECIPIENT_PREFIX, acknowledge, nextDeadline, repeatAlert, resolve } from '../../domain/incident';
import { freshness } from '../../domain/location';
import { applyServerIncident } from '../../domain/serverAlerts';
import { latestPayloadFor } from '../../domain/transport';
import type { Incident, ResolutionOutcome } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtCountdown, fmtTime } from '../format';
import { OptionList, ScreenHeader, initials } from '../components/Controls';
import { EscalationLadder } from '../components/EscalationLadder';
import { ArcGauge } from '../components/Gauges';
import { Icon } from '../components/Icon';
import { LocationStamp } from '../components/LocationStamp';
import { SimulatedTag } from '../components/SimulatedTag';
import { acknowledgeOnServer, fetchDemo, resolveOnServer } from '../api';
import { useLive } from '../hooks/useServerSession';

const hm = (t: number) => fmtTime(t).slice(0, 5);

function nextStepName(incident: Incident): string {
  const step = incident.steps[incident.currentStep + 1];
  if (!step) return '';
  return step.level === 'group'
    ? 'Group and backup contacts'
    : step.level === 'backup'
      ? 'Backup contacts'
      : step.level === 'host'
        ? 'Session host'
        : COPY.emergencySimulated;
}

export function AlertEscalationScreen({ incidentId }: { incidentId: string }) {
  const { state, me, meRecipient, store, go } = useApp();
  const now = useNow();
  const [outcome, setOutcome] = useState<ResolutionOutcome | null>(null);
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasDemoCall, setHasDemoCall] = useState(false);
  const { refreshAlerts } = useLive();

  const incident = state.incidents.find((i) => i.id === incidentId);
  const isHost = !!me && me.id === state.session?.hostId;
  const recipientId = meRecipient?.id ?? (me ? (isHost ? HOST_RECIPIENT_PREFIX : GROUP_RECIPIENT_PREFIX) + me.id : '');
  const payload = incident ? latestPayloadFor(state, incident.id, recipientId) : undefined;
  const back = () => go({ name: 'home' });

  const callReached = !!incident?.server && incident.steps.some((s) => s.level === 'emergency_simulated' && s.notifiedAt !== undefined);
  useEffect(() => {
    const serverId = state.session?.serverId;
    if (!serverId || !incident?.server) {
      setHasDemoCall(false);
      return;
    }
    let alive = true;
    const poll = async () => {
      const demo = await fetchDemo(serverId);
      if (!alive) return;
      setHasDemoCall(demo !== 'unavailable' && demo?.incidentId === incidentId && demo.call !== null);
    };
    void poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [incident?.server, incidentId, state.session?.serverId]);
  // follow the call only when the live incident demo placed one
  const calling = callReached && hasDemoCall;
  const callingBefore = useRef<boolean | null>(null);
  useEffect(() => {
    if (callingBefore.current === false && calling) go({ name: 'call', id: incidentId });
    callingBefore.current = calling;
  }, [calling, go, incidentId]);

  if (!incident || !payload) {
    return (
      <div className="screen">
        <div className="narrow">
          <ScreenHeader title="Alert" onBack={back} />
          <p className="t-lead">Nothing about this alert has been sent to you.</p>
        </div>
      </div>
    );
  }

  const staleAfter = state.session?.config.locationStaleAfterSec ?? 90;
  const open = incident.status === 'open';
  const selfCancelled = incident.resolution?.by === 'participant';
  // What the original alert said; the cancellation itself is shown below.
  const alertMessage =
    state.notifications
      .filter((n) => n.incidentId === incident.id && n.recipientId === recipientId && n.payload.kind !== 'cancelled')
      .sort((x, y) => y.deliveredAt - x.deliveredAt)[0]?.payload.message ?? payload.message;
  const deadline = nextDeadline(incident);
  const lastNotified = incident.steps[incident.currentStep]?.notifiedAt ?? incident.openedAt;
  const title =
    payload.trigger === 'help_requested' ? `${payload.participantName} asked for help` : `${COPY.movementChanged}: ${payload.participantName}`;

  const gauge = open
    ? deadline !== undefined
      ? {
          progress: (now - lastNotified) / (deadline - lastNotified),
          label: 'Next escalation',
          value: fmtCountdown(deadline - now),
          sub: nextStepName(incident),
          start: hm(lastNotified),
          end: hm(deadline),
          aria: `Next escalation to ${nextStepName(incident)} in ${fmtCountdown(deadline - now)}, at ${fmtTime(deadline)}`,
        }
      : { progress: 1, label: 'Escalation', value: 'All alerted', sub: '', start: '', end: '', aria: 'Every escalation step has been alerted.' }
    : {
        progress: 1,
        label: 'Escalation',
        value: 'Stopped',
        sub: selfCancelled
          ? `Cancelled ${fmtTime(incident.resolution!.at)}`
          : incident.acknowledged
            ? `Acknowledged ${fmtTime(incident.acknowledged.at)}`
            : '',
        start: '',
        end: '',
        aria: selfCancelled ? `Escalation stopped: ${payload.participantName} cancelled the alert.` : 'Escalation stopped by acknowledgment.',
      };

  // Server incidents: the server decides, and its answer replaces this device's copy.
  const onServer = !!incident.server;
  const viewerId = me?.id ?? '';
  const serverAction = async (call: () => ReturnType<typeof acknowledgeOnServer>) => {
    setBusy(true);
    const r = await call();
    if (r.ok) store.dispatch((d) => void applyServerIncident(d, r.data.incident, viewerId));
    else await refreshAlerts();
    setBusy(false);
    setFlash(r.ok ? null : r.message);
  };
  const doAcknowledge = () => {
    if (!onServer) return void store.dispatch((d, t) => acknowledge(d, incident.id, recipientId, t));
    const alertId = incident.server!.alertId;
    if (!alertId) return setFlash('This alert was not delivered to you, so you cannot acknowledge it.');
    void serverAction(() => acknowledgeOnServer(alertId));
  };
  const doResolve = () => {
    if (!outcome) return;
    if (!onServer) return void store.dispatch((d, t) => resolve(d, incident.id, recipientId, outcome, note, t));
    void serverAction(() => resolveOnServer(incident.id, outcome));
  };

  const doRepeat = () => {
    store.dispatch((d, t) => repeatAlert(d, incident.id, t));
    setFlash(COPY.repeatAlertSub);
  };

  return (
    <div className="screen">
      <ScreenHeader title="Alert" onBack={back} />
      <div className="cols">
        <div className="col">
          <section className={`surface card rise${open ? ' alert-open' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="header">
              <span className={`av num ${open ? 'on-danger' : 'fill'}`}>{initials(payload.participantName)}</span>
              <span className="stack grow">
                <h2 className="t-card">{title}</h2>
                <span className="t-sub">
                  {open
                    ? 'Unacknowledged'
                    : incident.status === 'acknowledged'
                      ? 'Acknowledged'
                      : selfCancelled
                        ? COPY.cancelledBySelf(payload.participantName)
                        : 'Resolved'}
                </span>
              </span>
            </div>
            <ArcGauge
              progress={gauge.progress}
              label={gauge.label}
              value={gauge.value}
              sub={gauge.sub}
              startLabel={gauge.start}
              endLabel={gauge.end}
              stopped={!open}
              ariaLabel={gauge.aria}
              role="timer"
            />
            <p className="t-sub center">{alertMessage}</p>
          </section>

          {open ? (
            <div className="col rise rise-2">
              <button type="button" className="btn pbtn on-danger" disabled={busy} onClick={doAcknowledge}>
                <Icon name="check" />
                {COPY.acknowledge}
              </button>
              <p className="t-sub center">{COPY.acknowledgeCaveat}</p>
              <div className="inline" style={{ justifyContent: 'center' }}>
                {/* The server has no repeat; its deadlines run regardless. */}
                {isHost && !onServer && (
                  <button type="button" className="btn chip fill" onClick={doRepeat}>
                    <Icon name="repeat" />
                    {COPY.repeatAlert}
                  </button>
                )}
                <button type="button" className="btn chip fill" onClick={() => go({ name: 'card', id: incident.id })}>
                  <Icon name="file" />
                  Incident card
                </button>
              </div>
              {flash && (
                <p className="t-cap center" role="status">
                  {flash}
                </p>
              )}
            </div>
          ) : (
            <section className="surface card col rise rise-2" style={{ gap: 16 }}>
              {incident.acknowledged && (
                <p className="t-body num" role="status">
                  {COPY.acknowledgedNotice(incident.acknowledged.name, fmtTime(incident.acknowledged.at))}
                </p>
              )}
              {selfCancelled ? (
                <div className="header" role="status">
                  <span className="av fill">
                    <Icon name="circleCheck" />
                  </span>
                  <span className="stack grow">
                    <span className="t-body num">
                      {payload.participantName} cancelled this alert from their own device at {fmtTime(incident.resolution!.at)}: false alarm.
                    </span>
                    <span className="t-sub">{COPY.cancelledBySelfCaveat}</span>
                  </span>
                </div>
              ) : incident.status === 'resolved' ? (
                <div className="header">
                  <span className="av fill">
                    <Icon name="circleCheck" />
                  </span>
                  <p className="t-body num grow">
                    Resolved by {incident.resolution!.name} at {fmtTime(incident.resolution!.at)}: {COPY.outcomes[incident.resolution!.outcome]}.
                    {incident.resolution!.note && ` "${incident.resolution!.note}"`}
                  </p>
                </div>
              ) : (
                <>
                  <OptionList<ResolutionOutcome>
                    label={COPY.resolve}
                    options={(Object.keys(COPY.outcomes) as ResolutionOutcome[]).map((o) => ({ value: o, label: COPY.outcomes[o] }))}
                    value={outcome}
                    onChange={setOutcome}
                  />
                  {/* The server records the outcome only, so no note is offered for its alerts. */}
                  {!onServer && (
                    <>
                      <label htmlFor="resnote" className="sr-only">
                        What happened (optional)
                      </label>
                      <textarea id="resnote" className="field" placeholder="What happened? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                    </>
                  )}
                  <button type="button" className="btn pbtn on-accent" disabled={!outcome || busy} onClick={doResolve}>
                    {COPY.resolve}
                  </button>
                  {flash && (
                    <p className="t-cap center" role="status">
                      {flash}
                    </p>
                  )}
                </>
              )}
              <div className="inline" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn chip fill" onClick={() => go({ name: 'card', id: incident.id })}>
                  <Icon name="file" />
                  Incident card
                </button>
              </div>
            </section>
          )}
          {callReached && hasDemoCall && (
            <button type="button" className="btn pbtn fill" onClick={() => go({ name: 'call', id: incident.id })}>
              Simulated emergency call <SimulatedTag />
            </button>
          )}
        </div>

        <div className="col">
          <section className="surface card card-list rise rise-3" aria-labelledby="esc-h">
            <div className="card-head">
              <h2 className="t-card" id="esc-h">
                Escalation
              </h2>
            </div>
            <EscalationLadder incident={incident} now={now} showNames={isHost} />
          </section>

          <section className="surface card rise rise-4" aria-labelledby="loc-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 className="t-card" id="loc-h">
              Last-known location
            </h2>
            {payload.lastKnownLocation ? (
              <LocationStamp
                reading={payload.lastKnownLocation}
                fresh={freshness(payload.lastKnownLocation, { isLatest: true, sourceOnline: true }, now, staleAfter)}
                now={now}
              />
            ) : (
              <p className="t-sub">{payload.locationWithheldReason ?? 'Unknown.'}</p>
            )}
            <span className="t-cap">Where their phone last reported, as sent to you. It may not be where they are now.</span>
          </section>

          {payload.emergencyNote && (
            <section className="surface card stack rise rise-4" style={{ gap: 8 }}>
              <h2 className="t-card">Note they chose to share</h2>
              <p className="t-body">"{payload.emergencyNote}"</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
