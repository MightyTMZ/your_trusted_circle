import { useEffect, useRef, useState } from 'react';
import { ingestMotion } from '../../domain/session';
import type { Store } from '../../domain/store';
import type { MotionSample } from '../../domain/types';

type PermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported';

/**
 * The browser's answer, kept for this page's lifetime: screens that use the hook
 * come and go (a check-in takes over the screen), and asking again would show
 * the prompt for a question already answered.
 */
let answered: 'granted' | 'denied' | null = null;

/**
 * Listens to devicemotion while the participant is in an active session with
 * motion monitoring enabled. Samples are buffered in memory and dispatched to
 * the store every 15 seconds (~4 writes/min) to keep localStorage churn low.
 * Anomaly detection latency is at most 15 s.
 */
export function useMotionTracking(
  store: Store,
  participantId: string | null,
): { permissionState: PermissionState; requestPermission: () => Promise<void> } {
  const [permissionState, setPermissionState] = useState<PermissionState>(answered ?? 'prompt');
  const bufferRef = useRef<MotionSample[]>([]);
  const flushRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pidRef = useRef(participantId);
  pidRef.current = participantId;

  const flush = () => {
    const pid = pidRef.current;
    if (!pid || bufferRef.current.length === 0) return;
    const batch = bufferRef.current.splice(0);
    store.dispatch((state) => {
      ingestMotion(state, pid, batch);
    });
  };

  const startListening = () => {
    const handler = (event: DeviceMotionEvent) => {
      const a = event.accelerationIncludingGravity;
      if (!a) return;
      const x = a.x ?? 0;
      const y = a.y ?? 0;
      const z = a.z ?? 0;
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      bufferRef.current.push({ at: Date.now(), magnitude, unit: 'm/s²', provenance: 'device' });
    };

    window.addEventListener('devicemotion', handler);
    flushRef.current = setInterval(flush, 15_000);
    answered = 'granted';
    setPermissionState('granted');

    return () => {
      window.removeEventListener('devicemotion', handler);
      if (flushRef.current) clearInterval(flushRef.current);
      flush();
    };
  };

  useEffect(() => {
    if (!participantId) return;
    if (!('DeviceMotionEvent' in window)) {
      setPermissionState('unsupported');
      return;
    }

    const DME = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof DME.requestPermission === 'function') {
      // Already allowed on this page: listen again without asking.
      if (answered === 'granted') return startListening();
      // iOS: need user gesture — stay in prompt state
      return;
    }

    // Non-iOS: start immediately
    return startListening();
  }, [participantId]);

  const requestPermission = async () => {
    const DME = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof DME.requestPermission === 'function') {
      try {
        const result = await DME.requestPermission();
        if (result === 'granted') {
          startListening();
        } else {
          answered = 'denied';
          setPermissionState('denied');
        }
      } catch {
        answered = 'denied';
        setPermissionState('denied');
      }
    } else {
      startListening();
    }
  };

  return { permissionState, requestPermission };
}
