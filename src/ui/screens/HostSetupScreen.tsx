import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, MAX_DURATION_MIN, MIN_DURATION_MIN, UNVALIDATED_LABEL } from '../../domain/config';
import { createSession, type ParticipantInput } from '../../domain/session';
import { COPY } from '../copy';
import { useApp } from '../context';
import { createSessionOnServer } from '../api';
import { CheckRow, ChipChoice, ScreenHeader, StepBar, Stepper } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ParticipantConsentFields, backupContactsReady, defaultParticipantInput } from '../components/ParticipantConsentFields';

const DURATIONS = [120, 240, 360];
const STEPS = 4;

/** Whole numbers only; blank counts as 0. Returns null for anything else. */
const wholeNumber = (s: string): number | null => (/^\d{0,3}$/.test(s.trim()) ? Number(s.trim() || '0') : null);

/** The custom time limit in minutes, or why it can't be used. */
function parseCustomLength(hours: string, minutes: string): { min: number } | { error: string } {
  const h = wholeNumber(hours);
  const m = wholeNumber(minutes);
  if (h === null || m === null) return { error: 'Use whole numbers for hours and minutes.' };
  if (m > 59) return { error: 'Minutes must be 59 or less.' };
  const total = h * 60 + m;
  if (total < MIN_DURATION_MIN) return { error: `At least ${MIN_DURATION_MIN} minutes.` };
  if (total > MAX_DURATION_MIN) return { error: `At most ${MAX_DURATION_MIN / 60} hours.` };
  return { min: total };
}

const fmtLength = (min: number) => `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;

export function HostSetupScreen() {
  const { store, setViewer, go, account } = useApp();
  const [step, setStep] = useState(1);
  const [sessionName, setSessionName] = useState('');
  const [lengthChoice, setLengthChoice] = useState<number | 'custom'>(240);
  const [customHours, setCustomHours] = useState('5');
  const [customMinutes, setCustomMinutes] = useState('0');
  const [commitment, setCommitment] = useState(false);
  const [host, setHost] = useState<ParticipantInput>(() => ({ ...defaultParticipantInput(), motionMonitoring: false, displayName: account?.displayName ?? '' }));
  const [cfg, setCfg] = useState({
    checkInWindowSec: DEFAULT_CONFIG.checkInWindowSec,
    hostAckWindowSec: DEFAULT_CONFIG.hostAckWindowSec,
    backupAckWindowSec: DEFAULT_CONFIG.backupAckWindowSec,
  });
  const [showTiming, setShowTiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const custom = lengthChoice === 'custom' ? parseCustomLength(customHours, customMinutes) : null;
  const customError = custom && 'error' in custom ? custom.error : null;
  // 240 (the default) whenever the custom entry isn't usable; the Continue button is blocked in that case.
  const durationMin = lengthChoice !== 'custom' ? lengthChoice : custom && 'min' in custom ? custom.min : 240;

  const accountName = account?.displayName;
  useEffect(() => {
    if (accountName) setHost((v) => (v.displayName ? v : { ...v, displayName: accountName }));
  }, [accountName]);

  // Sessions live on the server so others can join from their own phones, which needs an account.
  useEffect(() => {
    if (account === null) go({ name: 'signin' });
  }, [account, go]);

  const create = async () => {
    setCreating(true);
    setError(null);

    // Create on server to get an authoritative join code for cross-device QR.
    const serverResult = await createSessionOnServer({
      name: sessionName.trim() || `${host.displayName.trim()}'s group`,
      durationMin,
      consent: {
        monitoring: host.motionMonitoring,
        locationSharing: host.locationSharing,
        shareLocationWithResponders: host.shareLocationWithResponders,
        shareNoteWithResponders: host.shareNoteWithResponders,
      },
      consentTextVersion: 'consent-v1',
      ...(host.emergencyNote.trim() ? { responderNote: host.emergencyNote.trim().slice(0, 500) } : {}),
      backupContacts: host.backupContacts.filter((c) => c.name.trim() && c.relation.trim()).map((c) => ({ name: c.name.trim(), relation: c.relation.trim() })),
      rules: cfg,
    });

    if (typeof serverResult === 'string') {
      setCreating(false);
      return setError(serverResult);
    }

    // Create in client state for the local experience (motion, check-ins, etc.).
    let hostId = '';
    const err = store.dispatch((d, now) => {
      hostId = createSession(d, { sessionName, durationMin, hostCommitment: commitment, host, config: cfg }, now).host.id;
      // Overwrite the client code with the server's so the QR works cross-device.
      d.session!.code = serverResult.session.code!;
      d.session!.serverId = serverResult.session.id;
      if (serverResult.session.me) d.participants[hostId].serverId = serverResult.session.me.participantId;
    });
    setCreating(false);
    if (err) return setError(err);
    setViewer({ kind: 'participant', id: hostId });
    go({ name: 'invite' });
  };

  if (!account) return null;

  const blocked =
    creating ||
    (step === 1 && customError !== null) ||
    (step === 2 && !commitment) ||
    (step === 3 && !host.displayName.trim()) ||
    (step === 4 && !backupContactsReady(host.backupContacts));
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
            <ChipChoice<number | 'custom'>
              label="Ends automatically after"
              options={[...DURATIONS.map((m) => ({ value: m, label: `${m / 60} hours` })), { value: 'custom', label: 'Custom' }]}
              value={lengthChoice}
              onChange={setLengthChoice}
            />
            {lengthChoice === 'custom' && (
              <div className="fgroup">
                <div style={{ display: 'flex', gap: 12 }}>
                  <div className="fgroup grow">
                    <label className="lbl" htmlFor="customHours">
                      Hours
                    </label>
                    <input
                      id="customHours"
                      className="field num"
                      inputMode="numeric"
                      autoComplete="off"
                      value={customHours}
                      aria-invalid={customError !== null}
                      aria-describedby="customLengthNote"
                      onChange={(e) => setCustomHours(e.target.value)}
                    />
                  </div>
                  <div className="fgroup grow">
                    <label className="lbl" htmlFor="customMinutes">
                      Minutes
                    </label>
                    <input
                      id="customMinutes"
                      className="field num"
                      inputMode="numeric"
                      autoComplete="off"
                      value={customMinutes}
                      aria-invalid={customError !== null}
                      aria-describedby="customLengthNote"
                      onChange={(e) => setCustomMinutes(e.target.value)}
                    />
                  </div>
                </div>
                <p id="customLengthNote" className={customError ? 'error' : 't-sub num'} role={customError ? 'alert' : 'status'}>
                  {customError ?? `${fmtLength(durationMin)} from when you start, about ${new Date(Date.now() + durationMin * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="narrow rise" key="s2">
            <h2 className="t-title">{COPY.hostCommitmentTitle}</h2>
            <ul className="surface card card-list">
              {COPY.hostCommitmentPoints.map((p) => (
                <li key={p} className="row">
                  <span className="av av-sm fill">
                    <Icon name="check" size={16} />
                  </span>
                  <span className="t-body">{p}</span>
                </li>
              ))}
            </ul>
            <div className="surface card card-list">
              <CheckRow label={COPY.hostCommitmentCheck} checked={commitment} onChange={setCommitment} />
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
            <div className="surface card card-list">
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
