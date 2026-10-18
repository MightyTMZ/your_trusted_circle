import { MAX_BACKUP_CONTACTS } from '../../domain/config';
import type { ParticipantInput } from '../../domain/session';
import { ToggleRow } from './Controls';
import { Icon } from './Icon';

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

/**
 * The consent choices a person makes for themself. Never shown to anyone acting on their behalf.
 * Split into two parts so join and host setup can show them as separate steps.
 */
export function ParticipantConsentFields({
  value,
  onChange,
  checkInWindowSec,
  forHost = false,
  part,
}: {
  value: ParticipantInput;
  onChange(v: ParticipantInput): void;
  checkInWindowSec: number;
  forHost?: boolean;
  part: 'basics' | 'responders';
}) {
  const set = <K extends keyof ParticipantInput>(k: K, v: ParticipantInput[K]) => onChange({ ...value, [k]: v });

  if (part === 'basics') {
    return (
      <>
        <div className="fgroup">
          <label className="lbl" htmlFor="displayName">
            Your name
          </label>
          <input
            id="displayName"
            className="field"
            value={value.displayName}
            placeholder="Use a synthetic name for the demo"
            onChange={(e) => set('displayName', e.target.value)}
            autoComplete="off"
          />
        </div>
        <p className="t-sub">
          {forHost
            ? 'As host, your location is shared with everyone in the session.'
            : 'Joining shares your location with the group. You can limit it to the host later in Sharing.'}
        </p>
        <div className="surface card card-list">
          <ToggleRow
            label="Movement check-ins"
            sub={`You get a private check-in first. No answer within ${checkInWindowSec}s alerts ${forHost ? 'your backup contacts' : 'the host'}.`}
            checked={value.motionMonitoring}
            onChange={(v) => set('motionMonitoring', v)}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="fgroup">
        <span className="lbl">Backup contacts if an alert isn't acknowledged</span>
        {value.backupContacts.map((c, i) => (
          <div key={i} className="field-row">
            <input
              className="field"
              aria-label={`Backup contact ${i + 1} name`}
              placeholder="Name (synthetic)"
              value={c.name}
              onChange={(e) =>
                set('backupContacts', value.backupContacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <input
              className="field"
              aria-label={`Backup contact ${i + 1} relation`}
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
            className="btn chip fill"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => set('backupContacts', [...value.backupContacts, { name: '', relation: '' }])}
          >
            <Icon name="plus" />
            Add another
          </button>
        )}
      </div>
      <div className="fgroup">
        <label className="lbl" htmlFor="note">
          Note for responders (optional)
        </label>
        <textarea
          id="note"
          className="field"
          placeholder="Allergies or medication. Synthetic data only."
          value={value.emergencyNote}
          onChange={(e) => set('emergencyNote', e.target.value)}
        />
      </div>
      <div className="surface card card-list">
        <ToggleRow
          label="Share my last-known location with backup contacts and simulated emergency services during an alert"
          checked={value.shareLocationWithResponders}
          onChange={(v) => set('shareLocationWithResponders', v)}
        />
        <ToggleRow
          label="Share my name and note with alert recipients and simulated emergency services during an alert"
          checked={value.shareNoteWithResponders}
          onChange={(v) => set('shareNoteWithResponders', v)}
        />
      </div>
    </>
  );
}
