import { useState } from 'react';
import { HOST_RECIPIENT_PREFIX } from '../../domain/incident';
import { buildIncidentCard, type IncidentCard } from '../../domain/incidentCard';
import { describeOffset, freshness } from '../../domain/location';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtTime } from '../format';
import { LocationStamp } from '../components/LocationStamp';
import { Timeline } from '../components/Timeline';

function cardAsText(card: IncidentCard): string {
  const lines = [
    `YPC Incident Card · ${card.incidentId}`,
    `Participant: ${card.participantName}`,
    `Status: ${card.status}`,
    `Opened: ${fmtTime(card.openedAt)}`,
    card.lastKnownLocation
      ? `Last-known location (not current): ${describeOffset(card.lastKnownLocation)}, recorded ${fmtTime(card.lastKnownLocation.recordedAt)}`
      : `Location: ${card.locationNote ?? 'unknown'}`,
    '',
    'Observed events:',
    ...card.events.map((e) => `${fmtTime(e.at)}  ${e.text}${e.simulated ? ' [SIMULATED]' : ''}`),
    '',
    ...card.disclaimers.map((d) => `* ${d}`),
  ];
  return lines.join('\n');
}

export function IncidentCardScreen({ incidentId }: { incidentId: string }) {
  const { state, me, meRecipient, go } = useApp();
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const recipientId = meRecipient?.id ?? (me ? HOST_RECIPIENT_PREFIX + me.id : '');
  const card = buildIncidentCard(state, incidentId, recipientId);
  const staleAfter = state.session?.config.locationStaleAfterSec ?? 90;

  if (!card) return null;

  const statusLabel =
    card.status === 'open' ? 'Unacknowledged' : card.status === 'acknowledged' ? 'Acknowledged, not resolved' : 'Resolved';

  return (
    <div className="screen">
      <button className="btn btn-ghost back" onClick={() => go({ name: 'alert', id: incidentId })}>
        Back
      </button>
      <div className="stack">
        <span className="eyebrow">Incident Card</span>
        <h1 className="title">{card.participantName}</h1>
        <span className="small mono">{card.incidentId}</span>
      </div>

      <dl className="list" style={{ margin: 0 }}>
        <div className="list-row">
          <dt className="label grow">Status</dt>
          <dd style={{ margin: 0 }}>{statusLabel}</dd>
        </div>
        <div className="list-row">
          <dt className="label grow">Trigger</dt>
          <dd style={{ margin: 0 }}>{card.trigger === 'help_requested' ? 'Asked for help' : 'Missed check-in after movement changed'}</dd>
        </div>
        <div className="list-row">
          <dt className="label grow">Opened</dt>
          <dd className="mono" style={{ margin: 0 }}>
            {fmtTime(card.openedAt)}
          </dd>
        </div>
        {card.acknowledged && (
          <div className="list-row">
            <dt className="label grow">Acknowledged</dt>
            <dd style={{ margin: 0 }}>
              {card.acknowledged.name} · <span className="mono">{fmtTime(card.acknowledged.at)}</span>
            </dd>
          </div>
        )}
        {card.resolution && (
          <div className="list-row">
            <dt className="label grow">Resolved</dt>
            <dd style={{ margin: 0 }}>
              {COPY.outcomes[card.resolution.outcome]} · <span className="mono">{fmtTime(card.resolution.at)}</span>
            </dd>
          </div>
        )}
      </dl>

      <section className="stack">
        <span className="label">Last-known location</span>
        {card.lastKnownLocation ? (
          <LocationStamp
            reading={card.lastKnownLocation}
            fresh={freshness(card.lastKnownLocation, { isLatest: true, sourceOnline: true }, now, staleAfter)}
            now={now}
          />
        ) : (
          <p className="small">{card.locationNote ?? 'Unknown.'}</p>
        )}
      </section>

      {card.emergencyNote && (
        <section className="stack">
          <span className="label">Shared note</span>
          <p className="small">"{card.emergencyNote}"</p>
        </section>
      )}

      <section className="stack">
        <span className="label">Observed events</span>
        <Timeline entries={card.events} />
      </section>

      <section className="stack">
        {card.disclaimers.map((d) => (
          <p key={d} className="tiny">
            {d}
          </p>
        ))}
      </section>

      <div className="screen-footer">
        <button
          className="btn btn-secondary btn-block"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cardAsText(card));
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy as text'}
        </button>
      </div>
    </div>
  );
}
