import { useState } from 'react';
import { HOST_RECIPIENT_PREFIX } from '../../domain/incident';
import { buildIncidentCard, type IncidentCard } from '../../domain/incidentCard';
import { describeOffset, freshness } from '../../domain/location';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtCountdown, fmtTime } from '../format';
import { ScreenHeader } from '../components/Controls';
import { TickDial } from '../components/Gauges';
import { Icon } from '../components/Icon';
import { LocationStamp } from '../components/LocationStamp';
import { Timeline } from '../components/Timeline';

function cardAsText(card: IncidentCard): string {
  const lines = [
    `YTC Incident Card · ${card.incidentId}`,
    `Participant: ${card.participantName}`,
    `Status: ${card.status}${card.resolution?.by === 'participant' ? ` (cancelled by ${card.resolution.name} as a false alarm)` : ''}`,
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

const hm = (t: number) => fmtTime(t).slice(0, 5);

export function IncidentCardScreen({ incidentId }: { incidentId: string }) {
  const { state, me, meRecipient, go } = useApp();
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const recipientId = meRecipient?.id ?? (me ? HOST_RECIPIENT_PREFIX + me.id : '');
  const card = buildIncidentCard(state, incidentId, recipientId);
  const staleAfter = state.session?.config.locationStaleAfterSec ?? 90;
  if (!card) return null;

  const statusLabel =
    card.status === 'open'
      ? 'Unacknowledged'
      : card.status === 'acknowledged'
        ? 'Acknowledged, not resolved'
        : card.resolution?.by === 'participant'
          ? 'Cancelled by them'
          : 'Resolved';
  // The dial spans from the first observed event to the last escalation step (simulated emergency services).
  const start = card.events[0]?.at ?? card.openedAt;
  const lastStep = card.steps[card.steps.length - 1];
  const end = lastStep?.notifiedAt ?? lastStep?.dueAt;
  const notified = card.steps.filter((s) => s.notifiedAt !== undefined).length;
  const progress = end !== undefined && end > start ? (now - start) / (end - start) : notified / Math.max(1, card.steps.length);
  const since = card.trigger === 'help_requested' ? 'Since help was requested' : 'Since movement changed';

  return (
    <div className="screen">
      <ScreenHeader title="Incident card" onBack={() => go({ name: 'alert', id: incidentId })} backLabel="Back to alert" />
      <div className="cols">
        <div className="col">
          <section className="surface card rise" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 16px 20px' }}>
            <div className="spread">
              <span className="stack">
                <h2 className="t-card">{card.participantName}</h2>
                <span className="t-sub num">{card.incidentId}</span>
              </span>
              <span className={`tag ${card.status === 'open' ? 'on-danger' : ''}`}>{statusLabel}</span>
            </div>
            <TickDial
              progress={progress}
              label={since}
              value={fmtCountdown(now - start)}
              startLabel={hm(start)}
              endLabel={end !== undefined ? hm(end) : undefined}
              stopped={card.status !== 'open'}
              ariaLabel={`${since}: ${fmtCountdown(now - start)}.${end !== undefined ? ` Last escalation step at ${fmtTime(end)}.` : ''}`}
            />
          </section>

          <section className="surface card card-list rise rise-2" aria-labelledby="facts-h">
            <div className="card-head">
              <h2 className="t-card" id="facts-h">
                Facts
              </h2>
            </div>
            <dl>
              <div className="kv">
                <dt>Trigger</dt>
                <dd>{card.trigger === 'help_requested' ? 'Asked for help' : 'Missed check-in after movement changed'}</dd>
              </div>
              <div className="kv">
                <dt>Opened</dt>
                <dd className="num">{fmtTime(card.openedAt)}</dd>
              </div>
              {card.acknowledged && (
                <div className="kv">
                  <dt>Acknowledged</dt>
                  <dd className="num">
                    {card.acknowledged.name} · {fmtTime(card.acknowledged.at)}
                  </dd>
                </div>
              )}
              {card.resolution && (
                <div className="kv">
                  <dt>{card.resolution.by === 'participant' ? 'Cancelled' : 'Resolved'}</dt>
                  <dd className="num">
                    {card.resolution.by === 'participant'
                      ? `By ${card.resolution.name}, their own report · ${COPY.outcomes[card.resolution.outcome]} · ${fmtTime(card.resolution.at)}`
                      : `${COPY.outcomes[card.resolution.outcome]} · ${fmtTime(card.resolution.at)}`}
                  </dd>
                </div>
              )}
              <div className="kv kv-stack">
                <dt>Last-known location</dt>
                <dd>
                  {card.lastKnownLocation ? (
                    <LocationStamp
                      reading={card.lastKnownLocation}
                      fresh={freshness(card.lastKnownLocation, { isLatest: true, sourceOnline: true }, now, staleAfter)}
                      now={now}
                    />
                  ) : (
                    <span className="t-sub">{card.locationNote ?? 'Unknown'}</span>
                  )}
                </dd>
              </div>
              {card.emergencyNote && (
                <div className="kv kv-stack">
                  <dt>Shared note</dt>
                  <dd>"{card.emergencyNote}"</dd>
                </div>
              )}
            </dl>
          </section>
        </div>

        <div className="col">
          <section className="surface card rise rise-3" aria-labelledby="tl-h">
            <h2 className="t-card" id="tl-h" style={{ paddingBottom: 12 }}>
              Observed events
            </h2>
            <Timeline entries={card.events} />
          </section>
          <ul className="stack" style={{ gap: 6, padding: '0 4px' }}>
            {card.disclaimers.map((d) => (
              <li key={d} className="t-cap">
                {d}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn pbtn fill"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(cardAsText(card));
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Icon name="copy" />
            {copied ? 'Copied' : 'Copy as text'}
          </button>
        </div>
      </div>
    </div>
  );
}
