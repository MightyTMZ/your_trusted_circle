import { useEffect } from 'react';
import { AppProvider, store, useApp } from './ui/context';
import { ActiveSessionBar } from './ui/components/ActiveSessionBar';
import { DemoControls } from './ui/DemoControls';
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
import { StartScreen } from './ui/screens/StartScreen';
import { saveViewer } from './domain/store';
import type { Route } from './ui/context';

function readInitialRoute(): Route {
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

  if (meRecipient) {
    if (route.name === 'alert') return <AlertEscalationScreen incidentId={route.id} />;
    if (route.name === 'card') return <IncidentCardScreen incidentId={route.id} />;
    if (route.name === 'call') return <SimulatedEmergencyCallScreen incidentId={route.id} />;
    return <RecipientInboxScreen />;
  }

  if (!session || !me || me.sessionId !== session.id) return <StartScreen />;

  const pending = state.checkIns.find((c) => c.participantId === me.id && c.status === 'pending');
  if (pending && me.status === 'active' && me.device.online) return <ParticipantCheckInScreen checkIn={pending} />;

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
      <div className="stage">
        <main className="device">
          <div className="device-scroll">
            <ActiveSessionBar />
            <CurrentScreen />
          </div>
        </main>
        <DemoControls />
      </div>
    </AppProvider>
  );
}
