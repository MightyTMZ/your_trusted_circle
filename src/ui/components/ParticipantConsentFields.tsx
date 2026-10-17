import { MAX_BACKUP_CONTACTS } from '../../domain/config';
import type { ParticipantInput } from '../../domain/session';
import type { LocationSharing } from '../../domain/types';
import { SHARING_LABEL } from '../copy';

export function defaultParticipantInput(): ParticipantInput {
  return {
    displayName: '',
    locationSharing: 'group',
    motionMonitoring: true,
    shareLocationWithResponders: true,
    shareNoteWithResponders: false,
    emergencyNote: '',
    backupContacts: [{ name: '', relation: '' }],
  };
}

const SHARING_HELP: Record<LocationSharing, string> = {
  group: 'Everyone in this session sees where you are.',
  host: 'Only the host sees where you are.',
  off: 'Nobody in the group sees your location.',
};

/** The consent choices a person makes for themself. Never shown to anyone acting on their behalf. */
export function ParticipantConsentFields({
  value,
  onChange,
  checkInWindowSec,
  forHost = false,
}: {
  value: ParticipantInput;
  onChange(v: ParticipantInput): void;
  checkInWindowSec: number;
  forHost?: boolean;
}) {
  const set = <K extends keyof ParticipantInput>(k: K, v: ParticipantInput[K]) => onChange({ ...value, [k]: v });
  const options: LocationSharing[] = forHost ? ['group', 'off'] : ['group', 'host', 'off'];

  return (
    <>
      <div className="field">
        <label htmlFor="displayName">Your name</label>
        <input
          id="displayName"
          className="input"
          value={value.displayName}
          placeholder="Use a synthetic name for the demo"
          onChange={(e) => set('displayName', e.target.value)}
          autoComplete="off"
        />
      </div>

      <section className="stack">
        <span className="label">Who can see your location</span>
        <div className="choice-list" role="radiogroup">
          {options.map((o) => (
            <label key={o} className="choice" data-checked={value.locationSharing === o}>
              <input type="radio" name="sharing" checked={value.locationSharing === o} onChange={() => set('locationSharing', o)} />
              <span className="stack" style={{ gap: 2 }}>
                <span className="t">{SHARING_LABEL[o]}</span>
                <span className="small">{SHARING_HELP[o]}</span>
              </span>
            </label>
          ))}
        </div>
        <span className="tiny">You can change this anytime during the session.</span>
      </section>

      <label className="toggle">
        <input type="checkbox" checked={value.motionMonitoring} onChange={(e) => set('motionMonitoring', e.target.checked)} />
        <span className="stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Movement check-ins</span>
          <span className="small">
            The app learns your usual movement first. If it changes sharply, you get a private check-in. No answer within{' '}
            {checkInWindowSec}s alerts {forHost ? 'your backup contacts' : 'the host'}.
          </span>
        </span>
      </label>

      <section className="stack">
        <span className="label">Backup contacts if an alert isn't acknowledged</span>
        {value.backupContacts.map((c, i) => (
          <div key={i} className="row">
            <input
              className="input"
              placeholder="Name (synthetic)"
              value={c.name}
              onChange={(e) =>
                set('backupContacts', value.backupContacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <input
              className="input"
              style={{ maxWidth: 120 }}
              placeholder="Relation"
              value={c.relation}
              onChange={(e) =>
                set('backupContacts', value.backupContacts.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))
              }
            />
          </div>
        ))}
        {value.backupContacts.length < MAX_BACKUP_CONTACTS && (
          <button
            type="button"
            className="link small"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => set('backupContacts', [...value.backupContacts, { name: '', relation: '' }])}
          >
            Add another
          </button>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.shareLocationWithResponders}
            onChange={(e) => set('shareLocationWithResponders', e.target.checked)}
          />
          <span className="small">
            During an alert, share my last-known location with backup contacts and simulated emergency services.
          </span>
        </label>
      </section>

      <section className="stack">
        <label className="label" htmlFor="note">
          Note for responders (optional)
        </label>
        <textarea
          id="note"
          className="input"
          placeholder="e.g. allergies or medication. Synthetic data only."
          value={value.emergencyNote}
          onChange={(e) => set('emergencyNote', e.target.value)}
        />
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.shareNoteWithResponders}
            onChange={(e) => set('shareNoteWithResponders', e.target.checked)}
          />
          <span className="small">Share this note with alert recipients during an alert. Otherwise it stays private.</span>
        </label>
      </section>
    </>
  );
}
