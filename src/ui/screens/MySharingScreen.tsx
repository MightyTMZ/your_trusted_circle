import { recalibrate, updateConsent } from '../../domain/session';
import type { LocationSharing, ParticipantConsent } from '../../domain/types';
import { SHARING_LABEL } from '../copy';
import { useApp } from '../context';

/** A participant's own sharing settings. No one else can open or change these. */
export function MySharingScreen() {
  const { me, store, go, state } = useApp();
  const p = me!;
  const isHost = p.id === state.session?.hostId;
  const set = (patch: Partial<Omit<ParticipantConsent, 'joinedAt'>>) => store.dispatch((d) => updateConsent(d, p.id, p.id, patch));
  const options: LocationSharing[] = isHost ? ['group', 'off'] : ['group', 'host', 'off'];

  return (
    <div className="screen">
      <button className="btn btn-ghost back" onClick={() => go({ name: 'home' })}>
        Back
      </button>
      <div className="stack">
        <span className="eyebrow">Only you can change these</span>
        <h1 className="title">Your sharing</h1>
      </div>

      <section className="stack">
        <span className="label">Who can see your location</span>
        <div className="choice-list" role="radiogroup">
          {options.map((o) => (
            <label key={o} className="choice" data-checked={p.consent.locationSharing === o}>
              <input type="radio" checked={p.consent.locationSharing === o} onChange={() => set({ locationSharing: o })} />
              <span className="t">{SHARING_LABEL[o]}</span>
            </label>
          ))}
        </div>
      </section>

      <label className="toggle">
        <input type="checkbox" checked={p.consent.motionMonitoring} onChange={(e) => set({ motionMonitoring: e.target.checked })} />
        <span className="stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Movement check-ins</span>
          <span className="small">Turning this off stops new check-ins. Open alerts are not affected.</span>
        </span>
      </label>
      {p.consent.motionMonitoring && (
        <button
          className="btn btn-secondary"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => store.dispatch((d) => recalibrate(d, p.id, p.id))}
        >
          Relearn my usual movement
        </button>
      )}

      <label className="toggle">
        <input
          type="checkbox"
          checked={p.consent.shareLocationWithResponders}
          onChange={(e) => set({ shareLocationWithResponders: e.target.checked })}
        />
        <span className="small">During an alert, share my last-known location with backup contacts and simulated emergency services.</span>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={p.consent.shareNoteWithResponders}
          onChange={(e) => set({ shareNoteWithResponders: e.target.checked })}
        />
        <span className="small">Share my note for responders during an alert.</span>
      </label>

      <section className="stack">
        <span className="label">Backup contacts</span>
        {p.backupContacts.length === 0 ? (
          <p className="small">None. Unacknowledged alerts go straight to simulated emergency services.</p>
        ) : (
          p.backupContacts.map((c) => (
            <p key={c.id} className="small">
              {c.name}
              {c.relation && ` · ${c.relation}`}
            </p>
          ))
        )}
      </section>
    </div>
  );
}
