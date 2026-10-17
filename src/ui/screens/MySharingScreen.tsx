import { useState } from 'react';
import { recalibrate, updateConsent } from '../../domain/session';
import type { LocationSharing, ParticipantConsent } from '../../domain/types';
import { SHARING_LABEL } from '../copy';
import { useApp } from '../context';
import { OptionList, ToggleRow, initials } from '../components/Controls';
import { Icon } from '../components/Icon';

/** A participant's own sharing settings. No one else can open or change these. */
export function MySharingScreen() {
  const { me, store, state } = useApp();
  const [relearned, setRelearned] = useState(false);
  const p = me!;
  const isHost = p.id === state.session?.hostId;
  const set = (patch: Partial<Omit<ParticipantConsent, 'joinedAt'>>) => store.dispatch((d) => updateConsent(d, p.id, p.id, patch));
  const options: LocationSharing[] = isHost ? ['group', 'off'] : ['group', 'host', 'off'];
  return (
    <div className="screen">
      <div className="narrow">
        <h1 className="t-title">Your sharing</h1>
        <div className="rise">
          <OptionList
            label="Who can see your location"
            options={options.map((o) => ({ value: o, label: SHARING_LABEL[o] }))}
            value={p.consent.locationSharing}
            onChange={(o) => set({ locationSharing: o })}
          />
        </div>
        <section className="glass card card-list rise rise-2" aria-label="Check-ins and responders">
          <ToggleRow
            label="Movement check-ins"
            sub={p.consent.motionMonitoring ? undefined : 'Off. Open alerts are not affected.'}
            checked={p.consent.motionMonitoring}
            onChange={(v) => set({ motionMonitoring: v })}
          >
            {p.consent.motionMonitoring && (
              <button
                type="button"
                className="btn chip glass-2"
                style={{ alignSelf: 'flex-start', marginTop: 8 }}
                onClick={() => {
                  store.dispatch((d) => recalibrate(d, p.id, p.id));
                  setRelearned(true);
                }}
              >
                <Icon name="rotate" />
                {relearned ? 'Relearning your usual movement' : 'Relearn my usual movement'}
              </button>
            )}
          </ToggleRow>
          <ToggleRow
            label="Share my last-known location with backup contacts and simulated emergency services during an alert"
            checked={p.consent.shareLocationWithResponders}
            onChange={(v) => set({ shareLocationWithResponders: v })}
          />
          <ToggleRow
            label="Share my note with responders during an alert"
            checked={p.consent.shareNoteWithResponders}
            onChange={(v) => set({ shareNoteWithResponders: v })}
          />
        </section>
        <section className="glass card card-list rise rise-3" aria-labelledby="backups-h">
          <div className="card-head">
            <h2 className="t-card" id="backups-h">
              Backup contacts
            </h2>
          </div>
          {p.backupContacts.length === 0 ? (
            <p className="t-sub row">None. Unacknowledged alerts go straight to simulated emergency services.</p>
          ) : (
            <ul>
              {p.backupContacts.map((c) => (
                <li key={c.id} className="row">
                  <span className="av glass-2">{initials(c.name)}</span>
                  <span className="t-name grow">{c.name}</span>
                  {c.relation && <span className="t-sub">{c.relation}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
