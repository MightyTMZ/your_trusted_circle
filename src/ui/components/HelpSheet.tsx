import { useState } from 'react';
import { requestHelp } from '../../domain/session';
import { useApp } from '../context';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** Who a help request goes to first, by name where we have one. */
export function useFirstContact(): string {
  const { state, me } = useApp();
  const session = state.session;
  if (!session || !me) return 'your host';
  const isHost = me.id === session.hostId;
  const hostName = state.participants[session.hostId]?.displayName;
  const backups = me.backupContacts.map((c) => c.name).join(', ');
  return isHost
    ? backups
      ? `your backup contacts (${backups})`
      : 'your backup contacts'
    : hostName
      ? `${hostName} (your host)`
      : 'your host';
}

/** Confirms before alerting. Opened from the help button in the nav. */
export function HelpSheet({ onClose }: { onClose(): void }) {
  const { store, me } = useApp();
  const firstContact = useFirstContact();
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={`Alert ${firstContact} now?`} onClose={onClose}>
      <p className="t-lead">They will be alerted right away. If nobody acknowledges, it escalates.</p>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn pbtn on-accent"
        onClick={() => {
          const err = store.dispatch((d, t) => requestHelp(d, me!.id, t));
          if (err) setError(err);
          else onClose();
        }}
      >
        Send alert
      </button>
      <button type="button" className="btn pbtn fill" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
