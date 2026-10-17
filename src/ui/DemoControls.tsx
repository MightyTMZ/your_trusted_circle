import { useState } from 'react';
import { suddenChange, typicalMovement } from '../domain/scenarios';
import { emptyState, ingestMotion, setDeviceOnline } from '../domain/session';
import { useApp, useNow } from './context';
import { fmtTime } from './format';
import { joinUrl } from './screens/SessionInviteScreen';

/**
 * Presenter controls. Not part of the product UI. Scenario buttons feed
 * synthetic sensor input; they never set detector or escalation outcomes.
 */
export function DemoControls() {
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
    <aside className="demo" aria-label="Demo controls">
      <div>
        <h3>Demo controls · simulation only</h3>
        <p className="tiny">Presenter tools outside the app. Synthetic people, places, and sensor data.</p>
      </div>

      <div>
        <h3>Clock</h3>
        <div className="spread" style={{ marginBottom: 8 }}>
          <span className="mono">{fmtTime(now)}</span>
          <span className="tiny">offset +{Math.round(state.clockOffsetMs / 1000)}s</span>
        </div>
        <div className="btns">
          <button className="btn btn-secondary" onClick={() => advance(15_000)}>+15s</button>
          <button className="btn btn-secondary" onClick={() => advance(60_000)}>+1 min</button>
          <button className="btn btn-secondary" onClick={() => advance(5 * 60_000)}>+5 min</button>
        </div>
      </div>

      {session && (
        <div>
          <h3>View as</h3>
          <select
            className="input"
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
                className="btn btn-secondary"
                onClick={() => {
                  setViewer(null);
                  go({ name: 'join', code: session.code });
                }}
              >
                Join as new person here
              </button>
              <button className="btn btn-secondary" onClick={() => window.open(joinUrl(session.code), '_blank', 'noopener')}>
                Open join link in new tab
              </button>
            </div>
          )}
        </div>
      )}

      {session && target && (
        <div>
          <h3>Synthetic sensor input</h3>
          <select className="input" value={target.id} onChange={(e) => setTargetId(e.target.value)} style={{ marginBottom: 8 }}>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <p className="tiny" style={{ marginBottom: 8 }}>
            Baseline: {target.baseline.status}
            {target.baseline.status === 'calibrating' && ` ${target.baseline.n}/${session.config.detector.calibrationSamples}`}
            {!target.consent.motionMonitoring && ' · check-ins off (their choice), input ignored'}
          </p>
          <div className="btns">
            <button
              className="btn btn-secondary"
              onClick={() => store.dispatch((d, t) => ingestMotion(d, target.id, typicalMovement(30, t)))}
            >
              Typical movement (30 s)
            </button>
            <button className="btn btn-secondary" onClick={() => store.dispatch((d, t) => ingestMotion(d, target.id, suddenChange(t)))}>
              Sudden change (15 s)
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => store.dispatch((d, t) => setDeviceOnline(d, target.id, !target.device.online, t))}
            >
              {target.device.online ? 'Take phone offline' : 'Bring phone online'}
            </button>
          </div>
        </div>
      )}

      <div>
        <h3>Reset</h3>
        <button
          className="btn btn-secondary"
          onClick={() => {
            if (!confirm('Clear all demo data in this browser?')) return;
            store.dispatch((d) => void Object.assign(d, emptyState()));
            setViewer(null);
          }}
        >
          Clear demo data
        </button>
      </div>

      <p className="tiny">
        Prototype limits: tabs in this browser share state through local storage. Joining from another device needs a
        backend, which is not built. Thresholds are unvalidated.
      </p>
    </aside>
  );
}
