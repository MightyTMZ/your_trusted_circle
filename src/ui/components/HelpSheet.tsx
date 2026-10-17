import { useState } from 'react';
import { requestHelp } from '../../domain/session';
import { requestHelpOnServer } from '../api';
import { useApp } from '../context';
import { useLive } from '../hooks/useServerSession';
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
  const { store, me, state } = useApp();
  const { refreshAlerts } = useLive();
  const firstContact = useFirstContact();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const serverId = state.session?.serverId;

  const send = async () => {
    if (!serverId) {
      const err = store.dispatch((d, t) => requestHelp(d, me!.id, t));
      if (err) setError(err);
      else onClose();
      return;
    }
    // Server-backed: the server opens the alert, so the host's device sees it too.
    setSending(true);
    const r = await requestHelpOnServer(serverId);
    setSending(false);
    if (!r.ok) return setError(`${r.message} Your alert was not sent. Try again.`);
    await refreshAlerts();
    onClose();
  };
  return (
    <Sheet title={`Alert ${firstContact} now?`} onClose={onClose}>
      <p className="t-lead">They will be alerted right away. If nobody acknowledges, it escalates.</p>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}
      <button type="button" className="btn pbtn on-accent" disabled={sending} onClick={send}>
        {sending ? 'Sending…' : 'Send alert'}
      </button>
      <button type="button" className="btn pbtn fill" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
