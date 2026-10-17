import { useState } from 'react';
import { activeIncidentFor } from '../../domain/incident';
import { COPY } from '../copy';
import { useApp } from '../context';
import { HelpSheet } from './HelpSheet';
import { Icon, type IconName } from './Icon';

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
  const mine = activeIncidentFor(state, me.id);
  const alertTarget = hostAlerts[0];
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
      badge: !inAlert && hostAlerts.some((i) => i.status === 'open'),
      go: () => alertTarget && go({ name: 'alert', id: alertTarget.id }),
    });
  }
  items.push(
    { key: 'sharing', label: 'Your sharing', icon: 'mapPin', on: route.name === 'sharing', badge: false, go: () => go({ name: 'sharing' }) },
    { key: 'settings', label: 'Settings', icon: 'settings', on: route.name === 'settings', badge: false, go: () => go({ name: 'settings' }) },
  );
  return { items, canAskForHelp: !mine };
}

export function useNavItems(): NavItem[] | null {
  return useNav()?.items ?? null;
}

function Slot({ item }: { item: NavItem }) {
  return (
    <button
      type="button"
      className={`btn slot ${item.on ? 'is-on' : ''}`}
      aria-label={item.label}
      aria-current={item.on ? 'page' : undefined}
      onClick={item.go}
    >
      <Icon name={item.icon} />
      {item.badge && <span className="badge" aria-hidden="true" />}
    </button>
  );
}

function HelpSlot({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="btn slot slot-help" aria-label={COPY.checkInHelp} title={COPY.checkInHelp} onClick={onClick}>
      <Icon name="lifeBuoy" />
    </button>
  );
}

/**
 * Floating pill at the bottom on phones; a vertical rail on tablet and desktop.
 * "I need help" is the first slot (far left, or top of the rail), so it is one
 * tap away on every in-session screen without a button floating over content.
 */
export function AppNav({ variant }: { variant: 'rail' | 'bottom' }) {
  const nav = useNav();
  const [helpOpen, setHelpOpen] = useState(false);
  if (!nav) return null;
  const { items, canAskForHelp } = nav;
  const help = canAskForHelp && <HelpSlot onClick={() => setHelpOpen(true)} />;
  const sheet = helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />;

  if (variant === 'bottom') {
    return (
      <>
        <nav aria-label="Main" className="glass nav bottom-nav">
          {help}
          {/* Settings is a gear in the screen header on phones (SettingsButton). */}
          {items
            .filter((i) => i.key !== 'settings')
            .map((i) => (
              <Slot key={i.key} item={i} />
            ))}
        </nav>
        {sheet}
      </>
    );
  }

  const settings = items.find((i) => i.key === 'settings');
  return (
    <div className="app-rail">
      <nav aria-label="Main" className="glass nav nav-v">
        <div className="logo glass-2" role="img" aria-label="YTC">
          YTC
        </div>
        {help}
        {items
          .filter((i) => i.key !== 'settings')
          .map((i) => (
            <Slot key={i.key} item={i} />
          ))}
        <div style={{ flex: 1 }} />
        {settings && <Slot item={settings} />}
      </nav>
      {sheet}
    </div>
  );
}

/** Header gear for phones; tablet and desktop reach Settings from the rail. */
export function SettingsButton() {
  const { go } = useApp();
  return (
    <button type="button" className="btn ibtn glass phone-only" aria-label="Settings" onClick={() => go({ name: 'settings' })}>
      <Icon name="settings" />
    </button>
  );
}
