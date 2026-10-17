import { inboxFor } from '../../domain/transport';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { initials } from '../components/Controls';
import { Icon } from '../components/Icon';
import { SimulatedTag } from '../components/SimulatedTag';

/** What a simulated recipient (backup contact or emergency services) has been sent. Nothing more. */
export function RecipientInboxScreen() {
  const { state, meRecipient, go, setViewer } = useApp();
  const r = meRecipient!;
  const inbox = inboxFor(state, r.id);
  const isEmergency = r.kind === 'emergency_simulated';
  return (
    <div className="screen">
      <div className="narrow">
        <header className="header">
          <span className="av fill">{initials(r.name)}</span>
          <span className="stack grow">
            <h1 className="t-title">Messages</h1>
            <span className="t-sub">
              {r.name} · {isEmergency ? 'Simulated emergency services' : 'Backup contact'}
            </span>
          </span>
          <button type="button" className="btn ibtn fill" aria-label="Exit recipient view" onClick={() => setViewer(null)}>
            <Icon name="logOut" />
          </button>
        </header>
        <span style={{ alignSelf: 'flex-start' }}>
          <SimulatedTag />
        </span>
        {inbox.length === 0 ? (
          <p className="t-lead">Nothing has been sent to you.</p>
        ) : (
          <section className="surface card card-list rise" aria-label="Messages">
            {inbox.map((n) => (
              <button
                key={n.id}
                type="button"
                className="btn lrow"
                style={{ alignItems: 'flex-start', padding: '14px 0' }}
                onClick={() => go(isEmergency ? { name: 'call', id: n.incidentId } : { name: 'alert', id: n.incidentId })}
              >
                <span className="stack grow" style={{ gap: 6 }}>
                  <span className="inline">
                    <span className="t-cap num">{fmtTime(n.deliveredAt)}</span>
                    {n.repeat && <span className="tag">Repeat</span>}
                    {n.payload.kind === 'cancelled' && <span className="tag">Cancelled by them</span>}
                  </span>
                  <span className="t-body">{n.payload.message}</span>
                </span>
                <span className="chev" style={{ marginTop: 2 }}>
                  <Icon name="chevronRight" />
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
