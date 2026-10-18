import { useState } from 'react';
import { recalibrate, updateConsent } from '../../domain/session';
import type { LocationSharing, ParticipantConsent } from '../../domain/types';
import { SHARING_LABEL } from '../copy';
import { updateConsentOnServer } from '../api';
import { useApp } from '../context';
import { SettingsButton } from '../components/AppNav';
import { OptionList, ToggleRow, initials } from '../components/Controls';
import { Icon } from '../components/Icon';

const SHARING_HELP: Partial<Record<LocationSharing, string>> = {
  group: 'Everyone in this session sees where you are.',
  host: 'Only the host sees where you are.',
};

/** A participant's own sharing settings. No one else can open or change these. */
export function MySharingScreen() {
  const { me, store, state } = useApp();
  const [relearned, setRelearned] = useState(false);
  const p = me!;
  const isHost = p.id === state.session?.hostId;
  const [syncError, setSyncError] = useState(false);
  const set = (patch: Partial<Omit<ParticipantConsent, 'joinedAt'>>) => {
    store.dispatch((d) => updateConsent(d, p.id, p.id, patch));
    const serverId = state.session?.serverId;
    if (!serverId) return;
    const next = { ...p.consent, ...patch };
    updateConsentOnServer(serverId, {
      monitoring: next.motionMonitoring,
      locationSharing: next.locationSharing,
      shareLocationWithResponders: next.shareLocationWithResponders,
      shareNoteWithResponders: next.shareNoteWithResponders,
      consentTextVersion: 'consent-v1',
    }).then((ok) => setSyncError(!ok));
  };
  // Location always reaches at least the host; that is what lets the host respond.
  const options: LocationSharing[] = ['group', 'host'];
  return (
    <div className="screen">
      <div className="narrow">
        <header className="header">
          <h1 className="t-title grow">Your sharing</h1>
          <SettingsButton />
        </header>
        <div className="rise">
          {isHost ? (
            <section className="surface card stack" style={{ gap: 4 }}>
              <span className="lbl">Who can see your location</span>
              <span className="t-name">{SHARING_LABEL.group}</span>
              <span className="t-sub">As host, your location is always shared with the group.</span>
            </section>
          ) : (
            <OptionList
              label="Who can see your location"
              options={options.map((o) => ({ value: o, label: SHARING_LABEL[o], help: SHARING_HELP[o] }))}
              value={p.consent.locationSharing}
              onChange={(o) => set({ locationSharing: o })}
            />
          )}
        </div>
        {syncError && (
          <p className="error" role="alert">
            <Icon name="alert" />
            Saved on this device, but the server didn't get the change. Try again.
          </p>
        )}
        <section className="surface card card-list rise rise-2" aria-label="Check-ins and responders">
          <ToggleRow
            label="Movement check-ins"
            sub={p.consent.motionMonitoring ? undefined : 'Off. Open alerts are not affected.'}
            checked={p.consent.motionMonitoring}
            onChange={(v) => set({ motionMonitoring: v })}
          >
            {p.consent.motionMonitoring && (
              <button
                type="button"
                className="btn chip fill"
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
            label="Share my name and note with responders (including simulated emergency services) during an alert"
            checked={p.consent.shareNoteWithResponders}
            onChange={(v) => set({ shareNoteWithResponders: v })}
          />
        </section>
        <section className="surface card card-list rise rise-3" aria-labelledby="backups-h">
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
                  <span className="av fill">{initials(c.name)}</span>
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
