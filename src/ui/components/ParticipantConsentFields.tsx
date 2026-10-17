import { MAX_BACKUP_CONTACTS } from '../../domain/config';
import type { ParticipantInput } from '../../domain/session';
import type { LocationSharing } from '../../domain/types';
import { SHARING_LABEL } from '../copy';
import { OptionList, ToggleRow } from './Controls';
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

const SHARING_HELP: Record<LocationSharing, string> = {
  group: 'Everyone in this session sees where you are.',
  host: 'Only the host sees where you are.',
  off: 'Nobody in the group sees your location.',
};

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
  const options: LocationSharing[] = forHost ? ['group', 'off'] : ['group', 'host', 'off'];

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
        <OptionList
          label="Who can see your location"
          options={options.map((o) => ({ value: o, label: SHARING_LABEL[o], help: SHARING_HELP[o] }))}
          value={value.locationSharing}
          onChange={(o) => set('locationSharing', o)}
        />
        <div className="glass card card-list">
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
            className="btn chip glass"
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
      <div className="glass card card-list">
        <ToggleRow
          label="Share my last-known location with backup contacts and simulated emergency services during an alert"
          checked={value.shareLocationWithResponders}
          onChange={(v) => set('shareLocationWithResponders', v)}
        />
        <ToggleRow
          label="Share my note with alert recipients during an alert"
          checked={value.shareNoteWithResponders}
          onChange={(v) => set('shareNoteWithResponders', v)}
        />
      </div>
    </>
  );
}
