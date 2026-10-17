import { useState } from 'react';
import { DEFAULT_CONFIG, UNVALIDATED_LABEL } from '../../domain/config';
import { createSession, type ParticipantInput } from '../../domain/session';
import { COPY } from '../copy';
import { useApp } from '../context';
import { ChipChoice, ScreenHeader, StepBar, Stepper, ToggleRow } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ParticipantConsentFields, defaultParticipantInput } from '../components/ParticipantConsentFields';

const DURATIONS = [120, 240, 360];
const STEPS = 4;

export function HostSetupScreen() {
  const { store, setViewer, go } = useApp();
  const [step, setStep] = useState(1);
  const [sessionName, setSessionName] = useState('');
  const [durationMin, setDurationMin] = useState(240);
  const [commitment, setCommitment] = useState(false);
  const [host, setHost] = useState<ParticipantInput>(() => ({ ...defaultParticipantInput(), motionMonitoring: false }));
  const [cfg, setCfg] = useState({
    checkInWindowSec: DEFAULT_CONFIG.checkInWindowSec,
    hostAckWindowSec: DEFAULT_CONFIG.hostAckWindowSec,
    backupAckWindowSec: DEFAULT_CONFIG.backupAckWindowSec,
  });
  const [showTiming, setShowTiming] = useState(false);
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

  const blocked = (step === 2 && !commitment) || (step === 3 && !host.displayName.trim());
  const next = () => (step < STEPS ? setStep(step + 1) : create());

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader
          title="Start a session"
          onBack={() => (step > 1 ? setStep(step - 1) : go({ name: 'home' }))}
          right={<span className="t-sub num">{`${step} of ${STEPS}`}</span>}
        />
        <StepBar step={step} total={STEPS} />

        {step === 1 && (
          <div className="narrow rise" key="s1">
            <h2 className="t-title">Session</h2>
            <div className="fgroup">
              <label className="lbl" htmlFor="sessionName">
                Session name
              </label>
              <input
                id="sessionName"
                className="field"
                value={sessionName}
                placeholder="Friday at Ridgeway Hall"
                autoComplete="off"
                onChange={(e) => setSessionName(e.target.value)}
              />
            </div>
            <ChipChoice<number>
              label="Ends automatically after"
              options={DURATIONS.map((m) => ({ value: m, label: `${m / 60} hours` }))}
              value={durationMin}
              onChange={setDurationMin}
            />
          </div>
        )}

        {step === 2 && (
          <div className="narrow rise" key="s2">
            <h2 className="t-title">{COPY.hostCommitmentTitle}</h2>
            <ul className="glass card card-list">
              {COPY.hostCommitmentPoints.map((p) => (
                <li key={p} className="row">
                  <span className="av av-sm glass-2">
                    <Icon name="check" size={16} />
                  </span>
                  <span className="t-body">{p}</span>
                </li>
              ))}
            </ul>
            <div className="glass card card-list">
              <ToggleRow label={COPY.hostCommitmentCheck} checked={commitment} onChange={setCommitment} />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="narrow rise" key="s3">
            <h2 className="t-title">Your own sharing</h2>
            <ParticipantConsentFields value={host} onChange={setHost} checkInWindowSec={cfg.checkInWindowSec} forHost part="basics" />
          </div>
        )}

        {step === 4 && (
          <div className="narrow rise" key="s4">
            <h2 className="t-title">If something happens</h2>
            <ParticipantConsentFields value={host} onChange={setHost} checkInWindowSec={cfg.checkInWindowSec} forHost part="responders" />
            <div className="glass card card-list">
              <button type="button" className="btn lrow" aria-expanded={showTiming} onClick={() => setShowTiming(!showTiming)}>
                <span className="stack grow">
                  <span className="t-name">Escalation timing</span>
                  <span className="t-sub num">
                    Check-in {cfg.checkInWindowSec}s · Host {cfg.hostAckWindowSec}s · Backup {cfg.backupAckWindowSec}s
                  </span>
                </span>
                <span className="tag" title={UNVALIDATED_LABEL}>
                  Unvalidated
                </span>
                <span className="chev" style={{ display: 'flex', transform: showTiming ? 'rotate(90deg)' : undefined }}>
                  <Icon name="chevronRight" />
                </span>
              </button>
              {showTiming && (
                <>
                  <Stepper
                    label="Check-in window"
                    unit="s"
                    step={10}
                    min={10}
                    value={cfg.checkInWindowSec}
                    onChange={(v) => setCfg({ ...cfg, checkInWindowSec: v })}
                  />
                  <Stepper
                    label="Host acknowledgment"
                    unit="s"
                    step={10}
                    min={10}
                    value={cfg.hostAckWindowSec}
                    onChange={(v) => setCfg({ ...cfg, hostAckWindowSec: v })}
                  />
                  <Stepper
                    label="Backup acknowledgment"
                    unit="s"
                    step={10}
                    min={10}
                    value={cfg.backupAckWindowSec}
                    onChange={(v) => setCfg({ ...cfg, backupAckWindowSec: v })}
                  />
                </>
              )}
            </div>
          </div>
        )}

        <div className="screen-footer">
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className="btn pbtn on-accent" disabled={blocked} onClick={next}>
            {step < STEPS ? 'Continue' : 'Create session'}
          </button>
        </div>
      </div>
    </div>
  );
}
