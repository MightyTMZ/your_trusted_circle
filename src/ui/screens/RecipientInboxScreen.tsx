import { inboxFor } from '../../domain/transport';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { SimulatedTag } from '../components/SimulatedTag';

/** What a simulated recipient (backup contact or emergency services) has been sent. Nothing more. */
export function RecipientInboxScreen() {
  const { state, meRecipient, go } = useApp();
  const r = meRecipient!;
  const inbox = inboxFor(state, r.id);
  const isEmergency = r.kind === 'emergency_simulated';

  return (
    <div className="screen">
      <div className="stack">
        <div className="row" style={{ gap: 8 }}>
          <span className="eyebrow">{isEmergency ? 'Simulated emergency services' : 'Backup contact'}</span>
          <SimulatedTag />
        </div>
        <h1 className="title">Messages</h1>
        <p className="small">Delivered by the simulated transport. Nothing here was sent over a real network.</p>
      </div>

      {inbox.length === 0 ? (
        <p className="lead">Nothing has been sent to you.</p>
      ) : (
        <div className="list">
          {inbox.map((n) => (
            <div
              key={n.id}
              className="list-row clickable"
              onClick={() => go(isEmergency ? { name: 'call', id: n.incidentId } : { name: 'alert', id: n.incidentId })}
            >
              <div className="grow stack" style={{ gap: 2 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono small">{fmtTime(n.deliveredAt)}</span>
                  {n.repeat && <span className="tag">Repeat</span>}
                </div>
                <span>{n.payload.message}</span>
              </div>
              <span className="chev">›</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
