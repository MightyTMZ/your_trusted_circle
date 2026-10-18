import { useState } from 'react';
import { GROUP_RECIPIENT_PREFIX, activeIncidentFor } from '../../domain/incident';
import { COPY } from '../copy';
import { useApp } from '../context';
import { HelpSheet } from './HelpSheet';
import { Icon, type IconName } from './Icon';
import { SessionStatus } from './SessionStatus';

interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  on: boolean;
  badge: boolean;
  go(): void;
}

interface Nav {
  items: NavItem[];
  /** False while an alert about this person is already open. */
  canAskForHelp: boolean;
}

/** Nav for an active participant, or null when the screen has no navigation. */
export function useNav(): Nav | null {
  const { state, me, meRecipient, route, go } = useApp();
  const session = state.session;
  if (meRecipient || !me || !session || me.sessionId !== session.id) return null;
  if (session.status === 'ended' || me.status !== 'active') return null;
  if (route.name === 'host-setup' || route.name === 'join' || route.name === 'signin') return null;
  const pending = state.checkIns.some((c) => c.participantId === me.id && c.status === 'pending');
  if (pending && me.device.online) return null;

  const isHost = me.id === session.hostId;
  // Alerts the host can open: the newest unresolved one first.
  const hostAlerts = isHost
    ? state.incidents.filter((i) => i.participantId !== me.id && i.status !== 'resolved').sort((a, b) => b.openedAt - a.openedAt)
    : [];
  const responderAlerts = !isHost
    ? state.incidents
        .filter(
          (i) =>
            i.participantId !== me.id &&
            i.status !== 'resolved' &&
            state.notifications.some((n) => n.incidentId === i.id && n.recipientId === GROUP_RECIPIENT_PREFIX + me.id),
        )
        .sort((a, b) => b.openedAt - a.openedAt)
    : [];
  const mine = activeIncidentFor(state, me.id);
  const alertTarget = hostAlerts[0] ?? responderAlerts[0];
  const inAlert = route.name === 'alert' || route.name === 'card' || route.name === 'call';

  const items: NavItem[] = [
    {
      key: 'home',
      label: 'Group',
      icon: 'users',
      on: route.name === 'home' || route.name === 'invite',
      badge: !!mine,
      go: () => go({ name: 'home' }),
    },
  ];
  if (alertTarget || inAlert) {
    items.push({
      key: 'alert',
      label: 'Alert',
      icon: 'bell',
      on: inAlert,
      badge: !inAlert && [...hostAlerts, ...responderAlerts].some((i) => i.status === 'open'),
      go: () => alertTarget && go({ name: 'alert', id: alertTarget.id }),
    });
  }
  items.push(
    { key: 'sharing', label: 'Sharing', icon: 'mapPin', on: route.name === 'sharing', badge: false, go: () => go({ name: 'sharing' }) },
    { key: 'settings', label: 'Settings', icon: 'settings', on: route.name === 'settings', badge: false, go: () => go({ name: 'settings' }) },
  );
  return { items, canAskForHelp: !mine };
}

export function useNavItems(): NavItem[] | null {
  return useNav()?.items ?? null;
}

/** A tab (phone) or sidebar row (tablet and desktop): icon plus a visible label. */
function Slot({ item, variant }: { item: NavItem; variant: 'rail' | 'bottom' }) {
  return (
    <button
      type="button"
      className={`btn ${variant === 'bottom' ? 'tab' : 'side-item'} ${item.on ? 'is-on' : ''}`}
      aria-current={item.on ? 'page' : undefined}
      onClick={item.go}
    >
      <span className="slot-ic">
        <Icon name={item.icon} />
        {item.badge && <span className="badge" aria-hidden="true" />}
      </span>
      <span className="slot-label">{item.label}</span>
    </button>
  );
}

/**
 * Tab bar on phones (with the help button beside it, not inside it: tabs
 * navigate, help acts), a labelled sidebar on tablet and desktop. Help stays
 * one tap away on every in-session screen. The session indicator sits above
 * the tab bar, or near the top of the sidebar.
 */
export function AppNav({ variant }: { variant: 'rail' | 'bottom' }) {
  const nav = useNav();
  const [helpOpen, setHelpOpen] = useState(false);
  if (!nav) return null;
  const { items, canAskForHelp } = nav;
  const sheet = helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />;
  const open = () => setHelpOpen(true);

  if (variant === 'bottom') {
    return (
      <>
        <div className="tabbar-dock">
          <SessionStatus variant="accessory" />
          <div className="tabbar-row">
            {canAskForHelp ? (
              <button type="button" className="btn material help-fab" aria-label={COPY.checkInHelp} title={COPY.checkInHelp} onClick={open}>
                <Icon name="lifeBuoy" />
              </button>
            ) : (
              // An alert about you is open (shown at the top); the slot stays so the tabs never move.
              <span className="help-fab-slot" aria-hidden="true" />
            )}
            <nav aria-label="Main" className="material tabbar">
              {/* Settings is a gear in the screen header on phones (SettingsButton). */}
              {items
                .filter((i) => i.key !== 'settings')
                .map((i) => (
                  <Slot key={i.key} item={i} variant="bottom" />
                ))}
            </nav>
          </div>
        </div>
        {sheet}
      </>
    );
  }

  const settings = items.find((i) => i.key === 'settings');
  return (
    <div className="app-rail">
      <nav aria-label="Main" className="material sidebar">
        <div className="side-brand t-card">Your Trusted Circle</div>
        <SessionStatus variant="sidebar" />
        {canAskForHelp && (
          <button type="button" className="btn side-help" onClick={open}>
            <Icon name="lifeBuoy" />
            {COPY.checkInHelp}
          </button>
        )}
        {items
          .filter((i) => i.key !== 'settings')
          .map((i) => (
            <Slot key={i.key} item={i} variant="rail" />
          ))}
        <div style={{ flex: 1 }} />
        {settings && <Slot item={settings} variant="rail" />}
      </nav>
      {sheet}
    </div>
  );
}

/** Header gear for phones; tablet and desktop reach Settings from the rail. */
export function SettingsButton() {
  const { go } = useApp();
  return (
    <button type="button" className="btn ibtn fill phone-only" aria-label="Settings" onClick={() => go({ name: 'settings' })}>
      <Icon name="settings" />
    </button>
  );
}
