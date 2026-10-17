import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createStore, loadViewer, saveViewer, type Store, type Viewer } from '../domain/store';
import type { AppState, Participant, Recipient } from '../domain/types';

export type Route =
  | { name: 'home' }
  | { name: 'invite' }
  | { name: 'sharing' }
  | { name: 'alert'; id: string }
  | { name: 'card'; id: string }
  | { name: 'call'; id: string }
  | { name: 'host-setup' }
  | { name: 'join'; code: string };

interface Ctx {
  store: Store;
  state: AppState;
  viewer: Viewer;
  setViewer(v: Viewer): void;
  me: Participant | null;
  meRecipient: Recipient | null;
  route: Route;
  go(r: Route): void;
}

const AppCtx = createContext<Ctx | null>(null);

export const store = createStore();

export function AppProvider({ children, initialRoute }: { children: ReactNode; initialRoute: Route }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [viewer, setViewerState] = useState<Viewer>(() => loadViewer());
  const [route, setRoute] = useState<Route>(initialRoute);

  const setViewer = (v: Viewer) => {
    saveViewer(v);
    setViewerState(v);
    setRoute({ name: 'home' });
  };

  const me = viewer?.kind === 'participant' ? (state.participants[viewer.id] ?? null) : null;
  const meRecipient = viewer?.kind === 'recipient' ? (state.recipients[viewer.id] ?? null) : null;

  return (
    <AppCtx.Provider value={{ store, state, viewer, setViewer, me, meRecipient, route, go: setRoute }}>
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
