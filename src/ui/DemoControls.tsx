import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { suddenChange, typicalMovement } from '../domain/scenarios';
import { createSession, emptyState, ingestMotion, setDeviceOnline, type ParticipantInput } from '../domain/session';
import { useApp, useNow } from './context';
import { fmtTime } from './format';
import { Icon } from './components/Icon';
import { joinUrl } from './screens/SessionInviteScreen';
import { createSessionOnServer, endSessionOnServer, fetchDemo, setSessionVenueOnServer, startDemo, stopDemo, type DemoView } from './api';
import { applySessionVenue, resolveVenue, setLocalVenue, useDemoVenue, type Venue } from './venue';

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
  const { state, store, viewer, setViewer, go, account } = useApp();
  const now = useNow();
  // People who joined from other devices are driven by their own phones, not from here.
  const participants = Object.values(state.participants).filter((p) => p.status === 'active' && !p.remote);
  const recipients = Object.values(state.recipients).filter((r) => r.kind !== 'host');
  const [targetId, setTargetId] = useState('');
  const target = state.participants[targetId] ?? participants.find((p) => p.role === 'participant') ?? participants[0];
  const session = state.session;

  const viewerValue = viewer ? `${viewer.kind}:${viewer.id}` : '';
  const advance = (ms: number) => store.dispatch((d) => void (d.clockOffsetMs += ms));
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [operatorError, setOperatorError] = useState<string | null>(null);

  const startOperatorDemo = async () => {
    if (operatorBusy) return;
    if (!account) {
      setOperatorError('Sign in first to start the synthetic operator demo.');
      return;
    }

    setOperatorBusy(true);
    setOperatorError(null);
    const operatorTab = window.open('about:blank', '_blank');
    if (session?.serverId) {
      await stopDemo(session.serverId);
      await endSessionOnServer(session.serverId);
    }

    const hostName = account.displayName.trim() || 'Demo host';
    const host: ParticipantInput = {
      displayName: hostName,
      locationSharing: 'group',
      motionMonitoring: true,
      shareLocationWithResponders: true,
      shareNoteWithResponders: true,
      emergencyNote: 'Synthetic operator demonstration.',
      backupContacts: [{ name: 'Demo backup', relation: 'Friend' }],
    };
    const serverResult = await createSessionOnServer({
      name: 'Operator demo',
      durationMin: 120,
      consent: {
        monitoring: host.motionMonitoring,
        locationSharing: host.locationSharing,
        shareLocationWithResponders: host.shareLocationWithResponders,
        shareNoteWithResponders: host.shareNoteWithResponders,
      },
      consentTextVersion: 'consent-v1',
      responderNote: host.emergencyNote,
      backupContacts: host.backupContacts,
      rules: { checkInWindowSec: 20, hostAckWindowSec: 30, backupAckWindowSec: 30 },
    });

    if (typeof serverResult === 'string') {
      operatorTab?.close();
      setOperatorBusy(false);
      setOperatorError(serverResult);
      return;
    }
    const serverParticipantId = serverResult.session.me?.participantId;
    if (!serverParticipantId) {
      operatorTab?.close();
      setOperatorBusy(false);
      setOperatorError('The operator demo session did not return a host participant.');
      return;
    }

    const started = await startDemo(serverResult.session.id, serverParticipantId);
    if (!started.ok) {
      operatorTab?.close();
      setOperatorBusy(false);
      setOperatorError(started.message);
      return;
    }

    let hostId = '';
    const localError = store.dispatch((d, currentNow) => {
      hostId = createSession(
        d,
        {
          sessionName: 'Operator demo',
          durationMin: 120,
          hostCommitment: true,
          host,
          config: { checkInWindowSec: 20, hostAckWindowSec: 30, backupAckWindowSec: 30 },
        },
        currentNow,
      ).host.id;
      d.session!.code = serverResult.session.code!;
      d.session!.serverId = serverResult.session.id;
      d.participants[hostId].serverId = serverParticipantId;
    });
    if (localError) {
      operatorTab?.close();
      setOperatorBusy(false);
      setOperatorError(localError);
      return;
    }

    setViewer({ kind: 'participant', id: hostId });
    if (operatorTab) {
      operatorTab.location.href = `${window.location.origin}${window.location.pathname}#operator`;
    } else {
      setOperatorError('Allow pop-ups to open the operator console in another tab.');
    }
    setOperatorBusy(false);
  };

  return (
    <aside id="demo-panel" className="material demo" aria-label="Demo controls" style={style}>
      <div>
        <h3>Demo controls · simulation only</h3>
        <p className="t-cap">Presenter tools outside the app. Synthetic people, places, and sensor data.</p>
      </div>

      <div>
        <h3>Operator demo</h3>
        <button type="button" className="btn chip fill" disabled={operatorBusy} onClick={() => void startOperatorDemo()}>
          {operatorBusy ? 'Preparing operator demo…' : 'Start synthetic operator demo'}
        </button>
        {operatorError && (
          <p className="t-cap" role="alert" style={{ marginTop: 6 }}>
            {operatorError}
          </p>
        )}
        <p className="t-cap" style={{ marginTop: 6 }}>
          Starts a fresh synthetic session and opens the simulated operator line.
        </p>
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

      <VenuePicker />

      <IncidentDemo />

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
        Prototype limits: tabs in this browser share state through local storage. People who join from other devices
        appear through the backend, with their real location if they share it; their check-ins and alerts stay on their
        own phone for now. Thresholds are unvalidated.
      </p>
    </aside>
  );
}

const DEMO_STEP: Record<DemoView['phase'], string> = {
  before_impact: 'Evening loaded. Waiting for the impact',
  watching: 'Impact sent. Waiting for the detector',
  checkin_pending: 'Check-in on their phone. Leave it unanswered',
  answered_ok: 'They answered OK. No alert was sent',
  incident_open: 'No answer. The host is alerted; escalating',
  acknowledged: 'Acknowledged. Escalation stopped',
  calling: 'Calling the simulated operator',
  on_call: 'Operator on the line',
  resolved: 'Resolved',
  stopped: 'Stopped',
};

/**
 * The live incident demo (server sessions, host only). The server writes a
 * synthetic evening for one person, then sends a hard impact a few seconds
 * later. From there the real detector, check-in, escalation and simulated
 * call take over; nothing here sets an outcome.
 */
function IncidentDemo() {
  const { state, me } = useApp();
  const now = useNow();
  const serverId = state.session?.serverId;
  const isHost = !!me && me.id === state.session?.hostId;
  const people = Object.values(state.participants).filter((p) => p.status === 'active' && p.serverId);
  const [targetId, setTargetId] = useState('');
  const target = people.find((p) => p.id === targetId) ?? people.find((p) => p.role === 'participant') ?? people[0];
  const [demo, setDemo] = useState<DemoView | null | 'unavailable'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId || !isHost) return;
    let alive = true;
    const poll = async () => {
      const next = await fetchDemo(serverId);
      if (alive) setDemo(next);
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [serverId, isHost]);

  if (!serverId || !isHost) return null;
  if (demo === 'unavailable') {
    return (
      <div>
        <h3>Incident demo</h3>
        <p className="t-cap">Off on this server. Start it with DEMO_INCIDENTS=true (it is on with the localhost test sign-in).</p>
      </div>
    );
  }

  const running = !!demo && !['answered_ok', 'resolved', 'stopped'].includes(demo.phase);
  const start = async () => {
    if (!target?.serverId) return;
    setBusy(true);
    setError(null);
    const r = await startDemo(serverId, target.serverId);
    setBusy(false);
    if (r.ok) setDemo(r.data.demo);
    else setError(r.message);
  };
  const secs = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  const detail = !demo
    ? null
    : demo.phase === 'before_impact'
      ? `${demo.timelineEvents} events in their record. Impact in ${secs(demo.impactAt)} s.`
      : demo.phase === 'checkin_pending' && demo.checkIn
        ? `Due in ${secs(demo.checkIn.dueAt)} s.`
        : demo.phase === 'stopped'
          ? demo.stoppedReason
          : null;
  const callHref = demo?.call ? `#operator?call=${demo.call.id}` : null;

  return (
    <div>
      <h3>Incident demo</h3>
      {running && demo ? (
        <>
          <p className="t-name" role="status">
            {demo.name}: {DEMO_STEP[demo.phase]}
          </p>
          {detail && <p className="t-cap num">{detail}</p>}
          <div className="btns" style={{ marginTop: 8 }}>
            {callHref && (demo.phase === 'calling' || demo.phase === 'on_call') && (
              <button className="btn chip fill" onClick={() => (window.location.hash = callHref.slice(1))}>
                {demo.phase === 'calling' ? 'Answer as the operator' : 'Open the operator console'}
              </button>
            )}
            <button className="btn chip fill" onClick={() => serverId && stopDemo(serverId).then(() => fetchDemo(serverId).then(setDemo))}>
              Stop demo
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="t-cap" style={{ marginBottom: 8 }}>
            Loads about 90 minutes of synthetic evening for one person, then a hard impact about 5 s later. The real detector, check-in,
            escalation and simulated call do the rest. Check-in 20 s, each alert step 30 s.
          </p>
          {demo && <p className="t-cap" style={{ marginBottom: 8 }}>Last run: {demo.name}: {DEMO_STEP[demo.phase]}.{detail ? ` ${detail}` : ''}</p>}
          {people.length === 0 ? (
            <p className="t-cap">Nobody has joined yet.</p>
          ) : (
            <>
              <label className="sr-only" htmlFor="demo-person">
                Who the demo is about
              </label>
              <select id="demo-person" className="field" value={target?.id ?? ''} onChange={(e) => setTargetId(e.target.value)} style={{ marginBottom: 8 }}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.role === 'host' ? ' (host)' : ''}
                  </option>
                ))}
              </select>
              <div className="btns">
                <button className="btn chip fill" disabled={busy || !target} onClick={start}>
                  {busy ? 'Starting…' : 'Start incident demo'}
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="t-cap" role="alert" style={{ marginTop: 6 }}>
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The demo venue. In a server session the host sets it for everyone, and while
 * it is set every phone reports a simulated position there instead of its GPS.
 * Sessions only on this device keep a venue for this browser.
 */
function VenuePicker() {
  const { state, me } = useApp();
  const { venue, shared, local } = useDemoVenue();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverId = state.session?.serverId;
  const isHost = !!me && me.id === state.session?.hostId;
  const canEdit = !serverId || isHost;

  const save = async (v: Venue | null) => {
    if (!serverId) return setLocalVenue(v);
    const ok = await setSessionVenueOnServer(serverId, v);
    if (!ok) return setError("Couldn't save the venue on the server. Try again.");
    applySessionVenue(v);
  };
  const apply = async () => {
    setBusy(true);
    setError(null);
    const v = await resolveVenue(text);
    if (typeof v === 'string') {
      setBusy(false);
      return setError(v);
    }
    await save(v);
    setBusy(false);
    setText('');
  };
  const active = shared || local;

  return (
    <div>
      <h3>Demo venue</h3>
      <p className="t-cap" style={{ marginBottom: 8 }}>
        {shared
          ? `Everyone in this session appears around ${venue.label}, labelled simulated. Real GPS is paused until the venue is cleared.`
          : serverId
            ? 'Not set. Set a public place, like a club, and everyone in this session appears there, labelled simulated.'
            : `Simulated people appear around ${venue.label}. Use a public place.`}
      </p>
      {canEdit ? (
        <>
          <label className="sr-only" htmlFor="demo-venue">
            Venue address or coordinates
          </label>
          <input
            id="demo-venue"
            className="field"
            value={text}
            placeholder="Club address, or 43.6532, -79.3832"
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && !busy && apply()}
          />
          {error && (
            <p className="t-cap" role="alert" style={{ marginTop: 6 }}>
              {error}
            </p>
          )}
          <div className="btns" style={{ marginTop: 8 }}>
            <button className="btn chip fill" disabled={!text.trim() || busy} onClick={apply}>
              {busy ? 'Finding…' : shared || !serverId ? 'Change venue' : 'Set venue for everyone'}
            </button>
            {active && (
              <button className="btn chip fill" onClick={() => save(null)}>
                {serverId ? 'Clear venue, back to real GPS' : 'Back to the default venue'}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="t-cap">Only the host can change it.</p>
      )}
    </div>
  );
}
