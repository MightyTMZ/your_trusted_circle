import { offsetClock, type Clock } from './clock';
import { tick } from './escalation';
import { SessionError, emptyState } from './session';
import type { AppState, Millis } from './types';

/**
 * App state container. Persists to localStorage so tabs in the same browser
 * share one simulated "server" (prototype only: there is no backend).
 * Every mutation re-reads the latest stored state, applies, then runs the
 * scheduler with the same injected clock.
 */

const KEY = 'ypc-state-v1';

export type Mutation = (draft: AppState, now: Millis) => void;

export interface Store {
  getState(): AppState;
  subscribe(fn: () => void): () => void;
  /** Returns a user-facing error message, or null on success. */
  dispatch(m: Mutation): string | null;
  clock: Clock;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function createStore(): Store {
  const storage = safeStorage();
  let raw = '';
  const read = (): AppState | null => {
    try {
      const s = storage?.getItem(KEY);
      if (!s) return null;
      const parsed = JSON.parse(s) as AppState;
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  };

  let state: AppState = read() ?? emptyState();
  raw = JSON.stringify(state);
  const listeners = new Set<() => void>();
  const clock = offsetClock(() => state.clockOffsetMs);
  const notify = () => listeners.forEach((l) => l());

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      const next = read();
      if (!next) return;
      state = next;
      raw = JSON.stringify(state);
      notify();
    });
  }

  return {
    clock,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(m) {
      const draft = structuredClone(read() ?? state);
      const now = Date.now() + draft.clockOffsetMs;
      try {
        m(draft, now);
        // Re-read the clock: the mutation may have fast-forwarded it.
        tick(draft, Date.now() + draft.clockOffsetMs);
      } catch (e) {
        if (e instanceof SessionError) return e.message;
        throw e;
      }
      const next = JSON.stringify(draft);
      if (next === raw) return null;
      raw = next;
      state = draft;
      try {
        storage?.setItem(KEY, next);
      } catch {
        // Storage unavailable: state still lives in memory for this tab.
      }
      notify();
      return null;
    },
  };
}

/** Per-tab identity: which participant or simulated recipient this screen is acting as. */
export type Viewer = { kind: 'participant'; id: string } | { kind: 'recipient'; id: string } | null;

const VIEWER_KEY = 'ypc-viewer';

export function loadViewer(): Viewer {
  try {
    const s = sessionStorage.getItem(VIEWER_KEY);
    return s ? (JSON.parse(s) as Viewer) : null;
  } catch {
    return null;
  }
}

export function saveViewer(v: Viewer): void {
  try {
    if (v) sessionStorage.setItem(VIEWER_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(VIEWER_KEY);
  } catch {
    // Ignore: identity then lasts only for this page load.
  }
}
