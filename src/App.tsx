import { useEffect } from 'react';
import { AppProvider, store, useApp } from './ui/context';
import { AlertOverlay } from './ui/components/AlertOverlay';
import { AppNav, useNavItems } from './ui/components/AppNav';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { SignInScreen } from './ui/screens/SignInScreen';
import { DemoControls } from './ui/DemoControls';
import { LiveLocationProvider } from './ui/hooks/useServerSession';
import { AlertEscalationScreen } from './ui/screens/AlertEscalationScreen';
import { HostSetupScreen } from './ui/screens/HostSetupScreen';
import { IncidentCardScreen } from './ui/screens/IncidentCardScreen';
import { JoinSessionScreen } from './ui/screens/JoinSessionScreen';
import { MySharingScreen } from './ui/screens/MySharingScreen';
import { ParticipantCheckInScreen } from './ui/screens/ParticipantCheckInScreen';
import { RecipientInboxScreen } from './ui/screens/RecipientInboxScreen';
import { SessionHomeScreen } from './ui/screens/SessionHomeScreen';
import { SessionInviteScreen } from './ui/screens/SessionInviteScreen';
import { SimulatedEmergencyCallScreen } from './ui/screens/SimulatedEmergencyCallScreen';
import { LandingScreen } from './ui/screens/LandingScreen';
import { StartScreen } from './ui/screens/StartScreen';
import { saveViewer } from './domain/store';
import type { Route } from './ui/context';

function readInitialRoute(): Route {
  // A failed sign-in redirects back with #login_error=…; the sign-in screen reads it.
  if (window.location.hash.includes('login_error=')) return { name: 'signin' };
  // Preview of the landing page, until it replaces the start screen.
  if (window.location.hash === '#landing') return { name: 'landing' };
  const m = window.location.hash.match(/join=([A-Za-z0-9]{6})/);
  if (!m) return { name: 'home' };
  // A join link always starts a fresh identity in this tab.
  saveViewer(null);
  history.replaceState(null, '', window.location.pathname);
  return { name: 'join', code: m[1].toUpperCase() };
}

const initialRoute = readInitialRoute();

function CurrentScreen() {
  const { state, me, meRecipient, route } = useApp();
  const session = state.session;

  if (route.name === 'host-setup') return <HostSetupScreen />;
  if (route.name === 'join' && !me) return <JoinSessionScreen code={route.code} />;
  if (route.name === 'signin') return <SignInScreen />;
  if (route.name === 'landing' && !me) return <LandingScreen />;

  if (meRecipient) {
    if (route.name === 'alert') return <AlertEscalationScreen incidentId={route.id} />;
    if (route.name === 'card') return <IncidentCardScreen incidentId={route.id} />;
    if (route.name === 'call') return <SimulatedEmergencyCallScreen incidentId={route.id} />;
    return <RecipientInboxScreen />;
  }

  if (!session || !me || me.sessionId !== session.id) return route.name === 'settings' ? <SettingsScreen /> : <StartScreen />;

  // A pending check-in takes over every screen, settings included.
  const pending = state.checkIns.find((c) => c.participantId === me.id && c.status === 'pending');
  if (pending && me.status === 'active' && me.device.online) return <ParticipantCheckInScreen checkIn={pending} />;
  if (route.name === 'settings') return <SettingsScreen />;

  const isHost = me.id === session.hostId;
  switch (route.name) {
    case 'invite':
      return isHost && session.status !== 'ended' ? <SessionInviteScreen /> : <SessionHomeScreen />;
    case 'sharing':
      return me.status === 'active' ? <MySharingScreen /> : <SessionHomeScreen />;
    case 'alert':
      return <AlertEscalationScreen incidentId={route.id} />;
    case 'card':
      return <IncidentCardScreen incidentId={route.id} />;
    case 'call':
      return <SimulatedEmergencyCallScreen incidentId={route.id} />;
    default:
      return <SessionHomeScreen />;
  }
}

export function App() {
  useEffect(() => {
    // Scheduler heartbeat. Deadlines live in state, so a missed beat only delays, never cancels.
    const id = setInterval(() => store.dispatch(() => {}), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <AppProvider initialRoute={initialRoute}>
      <LiveLocationProvider>
        <div className="stage">
          <Shell />
          <DemoControls />
        </div>
      </LiveLocationProvider>
    </AppProvider>
  );
}

/** Sidebar on tablet and desktop, tab bar on phones; both carry the session indicator. */
function Shell() {
  const withNav = useNavItems() !== null;
  return (
    <div className={`app ${withNav ? 'with-nav' : ''}`}>
      <AppNav variant="rail" />
      <main className="app-main">
        <CurrentScreen />
      </main>
      <AppNav variant="bottom" />
      <AlertOverlay />
    </div>
  );
}
