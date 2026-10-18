import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createStore, loadViewer, saveViewer, type Store, type Viewer } from '../domain/store';
import type { AppState, Participant, Recipient } from '../domain/types';
import { fetchAccount, type Account } from './api';

export type Route =
  | { name: 'home' }
  | { name: 'landing' }
  | { name: 'invite' }
  | { name: 'sharing' }
  | { name: 'alert'; id: string }
  | { name: 'card'; id: string }
  | { name: 'call'; id: string }
  | { name: 'host-setup' }
  | { name: 'join'; code: string }
  | { name: 'settings' }
  | { name: 'signin' };

interface Ctx {
  store: Store;
  state: AppState;
  viewer: Viewer;
  setViewer(v: Viewer): void;
  me: Participant | null;
  meRecipient: Recipient | null;
  /** The signed-in account, null when signed out, undefined while loading. */
  account: Account | null | undefined;
  /** Refresh account state from the server. */
  refreshAccount(): Promise<void>;
  route: Route;
  go(r: Route): void;
  /** Join code saved when the user tried to join but wasn't signed in. */
  pendingJoinCode: string | null;
  setPendingJoinCode(code: string | null): void;
}

const AppCtx = createContext<Ctx | null>(null);

export const store = createStore();

export function AppProvider({ children, initialRoute }: { children: ReactNode; initialRoute: Route }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [viewer, setViewerState] = useState<Viewer>(() => loadViewer());
  const [route, setRoute] = useState<Route>(initialRoute);
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);

  const refreshAccount = async () => {
    const a = await fetchAccount();
    setAccount(a);
  };

  // Fetch account on mount to detect an existing session cookie.
  useEffect(() => {
    let alive = true;
    fetchAccount().then((a) => alive && setAccount(a));
    return () => { alive = false; };
  }, []);

  const setViewer = (v: Viewer) => {
    saveViewer(v);
    setViewerState(v);
    setRoute({ name: 'home' });
  };

  const me = viewer?.kind === 'participant' ? (state.participants[viewer.id] ?? null) : null;
  const meRecipient = viewer?.kind === 'recipient' ? (state.recipients[viewer.id] ?? null) : null;

  return (
    <AppCtx.Provider value={{ store, state, viewer, setViewer, me, meRecipient, account, refreshAccount, route, go: setRoute, pendingJoinCode, setPendingJoinCode }}>
      {children}
    </AppCtx.Provider>
  );
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

/** Current time from the injected clock, re-rendering every half second. */
export function useNow(): number {
  const [now, setNow] = useState(() => store.clock.now());
  const { state } = useApp();
  useEffect(() => {
    const id = setInterval(() => setNow(store.clock.now()), 500);
    return () => clearInterval(id);
  }, []);
  // Re-sync immediately when the demo clock offset changes.
  useEffect(() => setNow(store.clock.now()), [state.clockOffsetMs]);
  return now;
}
