import { useState } from 'react';
import { HOST_RECIPIENT_PREFIX, acknowledge, repeatAlert, resolve } from '../../domain/incident';
import { freshness } from '../../domain/location';
import { latestPayloadFor } from '../../domain/transport';
import type { ResolutionOutcome } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtTime } from '../format';
import { EscalationLadder } from '../components/EscalationLadder';
import { LocationStamp } from '../components/LocationStamp';
import { SimulatedTag } from '../components/SimulatedTag';

export function AlertEscalationScreen({ incidentId }: { incidentId: string }) {
  const { state, me, meRecipient, store, go } = useApp();
  const now = useNow();
  const [outcome, setOutcome] = useState<ResolutionOutcome | null>(null);
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const incident = state.incidents.find((i) => i.id === incidentId);
  const recipientId = meRecipient?.id ?? (me ? HOST_RECIPIENT_PREFIX + me.id : '');
  const isHost = !!me && me.id === state.session?.hostId;
  const payload = incident ? latestPayloadFor(state, incident.id, recipientId) : undefined;
  const back = () => go({ name: 'home' });

  if (!incident || !payload) {
    return (
      <div className="screen">
        <button className="btn btn-ghost back" onClick={back}>
          Back
        </button>
        <p className="lead">Nothing about this alert has been sent to you.</p>
      </div>
    );
  }

  const staleAfter = state.session?.config.locationStaleAfterSec ?? 90;
  const callReached = incident.steps.some((s) => s.level === 'emergency_simulated' && s.notifiedAt !== undefined);

  const doRepeat = () => {
    store.dispatch((d, t) => repeatAlert(d, incident.id, t));
    setFlash('Alert repeated. Escalation deadline unchanged.');
  };

  return (
    <div className="screen">
      <button className="btn btn-ghost back" onClick={back}>
        Back
      </button>

      <div className="stack">
        <div className="row" style={{ gap: 8 }}>
          <span className="eyebrow">Alert</span>
          <span className={`tag ${incident.status === 'open' ? 'tag-attention' : ''}`}>
            {incident.status === 'open' ? 'Unacknowledged' : incident.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
          </span>
        </div>
        <h1 className="title">
          {payload.trigger === 'help_requested' ? `${payload.participantName} asked for help` : `${COPY.movementChanged}: ${payload.participantName}`}
        </h1>
        <p className="lead">{payload.message}</p>
      </div>

      <section className="stack">
        <span className="label">Last-known location</span>
        {payload.lastKnownLocation ? (
          <LocationStamp
            reading={payload.lastKnownLocation}
            fresh={freshness(payload.lastKnownLocation, { isLatest: true, sourceOnline: true }, now, staleAfter)}
            now={now}
          />
        ) : (
          <p className="small">{payload.locationWithheldReason ?? 'Unknown.'}</p>
        )}
        <span className="tiny">This is where their phone last reported, as sent to you. It may not be where they are now.</span>
      </section>

      {payload.emergencyNote && (
        <section className="stack">
          <span className="label">Note they chose to share</span>
          <p className="small">"{payload.emergencyNote}"</p>
        </section>
      )}

      <section className="stack">
        <span className="label">Escalation</span>
        <EscalationLadder incident={incident} now={now} showNames={isHost} />
      </section>

      {/* Step 1: acknowledge. Always its own action. */}
      <section className="stack">
        {incident.status === 'open' ? (
          <>
            <button
              className="btn btn-attention btn-block btn-stacked"
              onClick={() => store.dispatch((d, t) => acknowledge(d, incident.id, recipientId, t))}
            >
              {COPY.acknowledge}
              <span className="btn-sub">{COPY.acknowledgeSub}</span>
            </button>
            <p className="tiny">{COPY.acknowledgeCaveat}</p>
            {isHost && (
              <>
                <button className="btn btn-secondary btn-block" onClick={doRepeat}>
                  {COPY.repeatAlert}
                </button>
                <p className="tiny">{flash ?? COPY.repeatAlertSub}</p>
              </>
            )}
          </>
        ) : (
          <p className="small">{COPY.acknowledgedNotice(incident.acknowledged!.name, fmtTime(incident.acknowledged!.at))}</p>
        )}
      </section>

      <hr className="divider" />

      {/* Step 2: resolve. Separate, and only after acknowledgment. */}
      <section className="stack">
        <h2 className="h2">{COPY.resolve}</h2>
        {incident.status === 'resolved' ? (
          <p className="small">
            Resolved by {incident.resolution!.name} at {fmtTime(incident.resolution!.at)}: {COPY.outcomes[incident.resolution!.outcome]}.
            {incident.resolution!.note && ` "${incident.resolution!.note}"`}
          </p>
        ) : (
          <>
            <p className="small">{incident.status === 'open' ? COPY.resolveLocked : COPY.resolveIntro}</p>
            <fieldset disabled={incident.status !== 'acknowledged'} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
              <div className="choice-list" role="radiogroup">
                {(Object.keys(COPY.outcomes) as ResolutionOutcome[]).map((o) => (
                  <label key={o} className="choice" data-checked={outcome === o}>
                    <input type="radio" name="outcome" checked={outcome === o} onChange={() => setOutcome(o)} />
                    <span className="t">{COPY.outcomes[o]}</span>
                  </label>
                ))}
              </div>
              <textarea className="input" placeholder="What happened? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button
                className="btn btn-secondary btn-block"
                disabled={!outcome}
                onClick={() => outcome && store.dispatch((d, t) => resolve(d, incident.id, recipientId, outcome, note, t))}
              >
                {COPY.resolve}
              </button>
            </fieldset>
          </>
        )}
      </section>

      <div className="screen-footer">
        <button className="btn btn-secondary btn-block" onClick={() => go({ name: 'card', id: incident.id })}>
          Incident Card
        </button>
        {callReached && (
          <button className="btn btn-secondary btn-block" onClick={() => go({ name: 'call', id: incident.id })}>
            Simulated emergency call <SimulatedTag />
          </button>
        )}
      </div>
    </div>
  );
}
