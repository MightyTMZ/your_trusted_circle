import { useState } from 'react';
import { DEFAULT_CONFIG, UNVALIDATED_LABEL } from '../../domain/config';
import { createSession, type ParticipantInput } from '../../domain/session';
import { COPY } from '../copy';
import { useApp } from '../context';
import { ParticipantConsentFields, defaultParticipantInput } from '../components/ParticipantConsentFields';

const DURATIONS = [120, 240, 360];

export function HostSetupScreen() {
  const { store, setViewer, go } = useApp();
  const [sessionName, setSessionName] = useState('');
  const [durationMin, setDurationMin] = useState(240);
  const [commitment, setCommitment] = useState(false);
  const [host, setHost] = useState<ParticipantInput>(() => ({ ...defaultParticipantInput(), motionMonitoring: false }));
  const [cfg, setCfg] = useState({
    checkInWindowSec: DEFAULT_CONFIG.checkInWindowSec,
    hostAckWindowSec: DEFAULT_CONFIG.hostAckWindowSec,
    backupAckWindowSec: DEFAULT_CONFIG.backupAckWindowSec,
  });
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    let hostId = '';
    const err = store.dispatch((d, now) => {
      hostId = createSession(d, { sessionName, durationMin, hostCommitment: commitment, host, config: cfg }, now).host.id;
    });
    if (err) return setError(err);
    setViewer({ kind: 'participant', id: hostId });
    go({ name: 'invite' });
  };

  const num = (k: keyof typeof cfg, label: string) => (
    <div className="field" style={{ flex: 1 }}>
      <label htmlFor={k}>{label}</label>
      <input
        id={k}
        className="input mono"
        type="number"
        min={10}
        value={cfg[k]}
        onChange={(e) => setCfg({ ...cfg, [k]: Math.max(10, Number(e.target.value) || 0) })}
      />
    </div>
  );

  return (
    <div className="screen">
      <button className="btn btn-ghost back" onClick={() => go({ name: 'home' })}>
        Back
      </button>
      <div className="stack">
        <span className="eyebrow">Session host</span>
        <h1 className="title">Start a session</h1>
      </div>

      <div className="field">
        <label htmlFor="sessionName">Session name</label>
        <input
          id="sessionName"
          className="input"
          value={sessionName}
          placeholder="Friday at Ridgeway Hall"
          onChange={(e) => setSessionName(e.target.value)}
        />
      </div>

      <div className="stack">
        <span className="label">Ends automatically after</span>
        <div className="segmented">
          {DURATIONS.map((m) => (
            <button key={m} aria-pressed={durationMin === m} onClick={() => setDurationMin(m)}>
              {m / 60} hours
            </button>
          ))}
        </div>
      </div>

      <section className={`panel ${commitment ? '' : 'panel-attention'}`}>
        <h2 className="h2">{COPY.hostCommitmentTitle}</h2>
        <p className="small">Alerts come to you first. The group is counting on you being able to act.</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {COPY.hostCommitmentPoints.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <label className="toggle">
          <input type="checkbox" checked={commitment} onChange={(e) => setCommitment(e.target.checked)} />
          <span style={{ fontWeight: 600 }}>{COPY.hostCommitmentCheck}</span>
        </label>
      </section>

      <hr className="divider" />
      <div className="stack">
        <h2 className="h2">Your own sharing</h2>
        <p className="small">You're part of the group too. These choices apply only to you.</p>
      </div>
      <ParticipantConsentFields value={host} onChange={setHost} checkInWindowSec={cfg.checkInWindowSec} forHost />

      <details className="stack">
        <summary className="label" style={{ cursor: 'pointer' }}>
          Escalation timing
        </summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row">
            {num('checkInWindowSec', 'Check-in window (s)')}
            {num('hostAckWindowSec', 'Host ack window (s)')}
          </div>
          {num('backupAckWindowSec', 'Backup ack window before simulated emergency services (s)')}
          <span className="tiny">{UNVALIDATED_LABEL}s. Not tested against real-world data.</span>
        </div>
      </details>

      <div className="screen-footer">
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={!commitment || !host.displayName.trim()} onClick={create}>
          Create session and show QR code
        </button>
        {!commitment && <p className="tiny">Accept the host commitment to continue.</p>}
      </div>
    </div>
  );
}
