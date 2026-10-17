import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { suddenChange, typicalMovement } from '../domain/scenarios';
import { emptyState, ingestMotion, setDeviceOnline } from '../domain/session';
import { useApp, useNow } from './context';
import { fmtTime } from './format';
import { Icon } from './components/Icon';
import { joinUrl } from './screens/SessionInviteScreen';

const POS_KEY = 'ytc.demoFab';
const GAP = 16;
const DRAG_SLOP = 4;

type Pos = { x: number; y: number };

function readPos(): Pos | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
  } catch {
    return null;
  }
}

function savePos(p: Pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    // Position is a convenience; losing it is fine.
  }
}

function clamp(p: Pos, w: number, h: number): Pos {
  return {
    x: Math.min(Math.max(GAP, p.x), Math.max(GAP, window.innerWidth - w - GAP)),
    y: Math.min(Math.max(GAP, p.y), Math.max(GAP, window.innerHeight - h - GAP)),
  };
}

/**
 * Presenter tools behind a small draggable button. Drag to move it out of the
 * way; tap to open the panel, which opens toward the middle of the screen.
 */
export function DemoControls() {
  const fab = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [pos, setPos] = useState<Pos | null>(readPos);
  const [open, setOpen] = useState(false);

  const size = () => {
    const r = fab.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };

  // Default spot: bottom right, above the phone tab bar and session pill. Re-clamp on resize.
  useLayoutEffect(() => {
    const fit = () => {
      const { w, h } = size();
      setPos((p) => clamp(p ?? { x: window.innerWidth, y: window.innerHeight - h - 168 }, w, h));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !pos) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, sx: e.clientX, sy: e.clientY, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_SLOP) return;
    d.moved = true;
    const { w, h } = size();
    setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, w, h));
  };
  const onPointerUp = () => {
    if (drag.current?.moved && pos) savePos(pos);
  };
  // A drag ends with a click event; only a tap toggles.
  const onClick = useCallback(() => {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) setOpen((o) => !o);
  }, []);

  return (
    <div className="demo-dock" style={pos ? { left: pos.x, top: pos.y } : { visibility: 'hidden' }}>
      <button
        ref={fab}
        type="button"
        className={`btn material demo-fab ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-controls="demo-panel"
        aria-label={open ? 'Close demo controls' : 'Open demo controls (drag to move)'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onClick={onClick}
      >
        <Icon name={open ? 'x' : 'play'} size={16} />
        Demo
      </button>
      {open && pos && <DemoPanel style={panelPlacement(pos, size())} />}
    </div>
  );
}

/** Opens toward the larger free space, so it never runs off screen. */
function panelPlacement(pos: Pos, fab: { w: number; h: number }): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(340, vw - 2 * GAP);
  const left = Math.min(Math.max(GAP, pos.x + fab.w / 2 < vw / 2 ? pos.x : pos.x + fab.w - width), vw - width - GAP) - pos.x;
  const below = pos.y + fab.h / 2 < vh / 2;
  const room = below ? vh - (pos.y + fab.h) - 8 - GAP : pos.y - 8 - GAP;
  return {
    width,
    left,
    maxHeight: Math.max(160, room),
    ...(below ? { top: fab.h + 8 } : { bottom: fab.h + 8 }),
  };
}

/**
 * Presenter controls. Not part of the product UI. Scenario buttons feed
 * synthetic sensor input; they never set detector or escalation outcomes.
 */
function DemoPanel({ style }: { style: CSSProperties }) {
  const { state, store, viewer, setViewer, go } = useApp();
  const now = useNow();
  const participants = Object.values(state.participants).filter((p) => p.status === 'active');
  const recipients = Object.values(state.recipients).filter((r) => r.kind !== 'host');
  const [targetId, setTargetId] = useState('');
  const target = state.participants[targetId] ?? participants.find((p) => p.role === 'participant') ?? participants[0];
  const session = state.session;

  const viewerValue = viewer ? `${viewer.kind}:${viewer.id}` : '';
  const advance = (ms: number) => store.dispatch((d) => void (d.clockOffsetMs += ms));

  return (
    <aside id="demo-panel" className="material demo" aria-label="Demo controls" style={style}>
      <div>
        <h3>Demo controls · simulation only</h3>
        <p className="t-cap">Presenter tools outside the app. Synthetic people, places, and sensor data.</p>
      </div>

      <div>
        <h3>Clock</h3>
        <div className="spread" style={{ marginBottom: 8 }}>
          <span className="t-name num">{fmtTime(now)}</span>
          <span className="t-cap">offset +{Math.round(state.clockOffsetMs / 1000)}s</span>
        </div>
        <div className="btns">
          <button className="btn chip fill" onClick={() => advance(15_000)}>+15s</button>
          <button className="btn chip fill" onClick={() => advance(60_000)}>+1 min</button>
          <button className="btn chip fill" onClick={() => advance(5 * 60_000)}>+5 min</button>
        </div>
      </div>

      {session && (
        <div>
          <h3>View as</h3>
          <select
            className="field"
            value={viewerValue}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(':');
              setViewer(kind ? ({ kind, id } as never) : null);
            }}
          >
            <option value="">Nobody (start screen)</option>
            {participants.map((p) => (
              <option key={p.id} value={`participant:${p.id}`}>
                {p.displayName}
                {p.role === 'host' ? ' (host)' : ''}
              </option>
            ))}
            {recipients.map((r) => (
              <option key={r.id} value={`recipient:${r.id}`}>
                {r.name} · inbox
              </option>
            ))}
          </select>
          {session.status !== 'ended' && (
            <div className="btns" style={{ marginTop: 8 }}>
              <button
                className="btn chip fill"
                onClick={() => {
                  setViewer(null);
                  go({ name: 'join', code: session.code });
                }}
              >
                Join as new person here
              </button>
              <button className="btn chip fill" onClick={() => window.open(joinUrl(session.code), '_blank', 'noopener')}>
                Open join link in new tab
              </button>
            </div>
          )}
        </div>
      )}

      {session && target && (
        <div>
          <h3>Synthetic sensor input</h3>
          <select className="field" value={target.id} onChange={(e) => setTargetId(e.target.value)} style={{ marginBottom: 8 }}>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <p className="t-cap" style={{ marginBottom: 8 }}>
            Baseline: {target.baseline.status}
            {target.baseline.status === 'calibrating' && ` ${target.baseline.n}/${session.config.detector.calibrationSamples}`}
            {!target.consent.motionMonitoring && ' · check-ins off (their choice), input ignored'}
          </p>
          <div className="btns">
            <button
              className="btn chip fill"
              onClick={() => store.dispatch((d, t) => ingestMotion(d, target.id, typicalMovement(30, t)))}
            >
              Typical movement (30 s)
            </button>
            <button className="btn chip fill" onClick={() => store.dispatch((d, t) => ingestMotion(d, target.id, suddenChange(t)))}>
              Sudden change (15 s)
            </button>
            <button
              className="btn chip fill"
              onClick={() => store.dispatch((d, t) => setDeviceOnline(d, target.id, !target.device.online, t))}
            >
              {target.device.online ? 'Take phone offline' : 'Bring phone online'}
            </button>
          </div>
        </div>
      )}

      <div>
        <h3>Voice agent</h3>
        <div className="btns">
          <a className="btn chip fill" href="#operator">
            Play the operator (live voice)
          </a>
        </div>
        <p className="t-cap" style={{ marginTop: 6 }}>
          Needs the YTC backend: npm run server. Synthetic incident; simulated call only.
        </p>
      </div>

      <div>
        <h3>Reset</h3>
        <button
          className="btn chip fill"
          onClick={() => {
            if (!confirm('Clear all demo data in this browser?')) return;
            store.dispatch((d) => void Object.assign(d, emptyState()));
            setViewer(null);
          }}
        >
          Clear demo data
        </button>
      </div>

      <p className="t-cap">
        Prototype limits: tabs in this browser share state through local storage. Joining from another device needs a
        backend, which is not built. Thresholds are unvalidated.
      </p>
    </aside>
  );
}
