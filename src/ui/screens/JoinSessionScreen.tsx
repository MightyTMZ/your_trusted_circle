import { useState } from 'react';
import { joinSession, type ParticipantInput } from '../../domain/session';
import { useApp } from '../context';
import { ScreenHeader, StepBar, initials } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ParticipantConsentFields, defaultParticipantInput } from '../components/ParticipantConsentFields';

export function JoinSessionScreen({ code }: { code: string }) {
  const { state, store, setViewer, go } = useApp();
  const [step, setStep] = useState(1);
  const [input, setInput] = useState<ParticipantInput>(defaultParticipantInput);
  const [error, setError] = useState<string | null>(null);
  const session = state.session;

  if (!session || session.code !== code || session.status === 'ended') {
    return (
      <div className="screen">
        <div className="narrow">
          <ScreenHeader title="Join session" onBack={() => go({ name: 'home' })} />
          <div className="glass card stack" style={{ gap: 8 }}>
            <h2 className="t-card">This session isn't available</h2>
            <p className="t-sub">It may have ended or expired. Ask the host for a new QR code.</p>
          </div>
        </div>
      </div>
    );
  }

  const host = state.participants[session.hostId];
  const join = () => {
    let id = '';
    const err = store.dispatch((d, now) => {
      id = joinSession(d, code, input, now).id;
    });
    if (err) return setError(err);
    setViewer({ kind: 'participant', id });
  };

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader
          title="Join session"
          onBack={() => (step > 1 ? setStep(1) : go({ name: 'home' }))}
          right={<span className="t-sub num">{`${step} of 2`}</span>}
        />
        <StepBar step={step} total={2} />
        <section className="glass card rise" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="av glass-2">{initials(host?.displayName ?? '?')}</span>
          <span className="stack grow">
            <span className="t-card">{session.name}</span>
            <span className="t-sub">Hosted by {host?.displayName} · Stays sober and gets alerts first</span>
          </span>
        </section>
        {step === 1 ? (
          <div className="narrow rise rise-2" key="j1">
            <ParticipantConsentFields value={input} onChange={setInput} checkInWindowSec={session.config.checkInWindowSec} part="basics" />
          </div>
        ) : (
          <div className="narrow rise" key="j2">
            <ParticipantConsentFields value={input} onChange={setInput} checkInWindowSec={session.config.checkInWindowSec} part="responders" />
          </div>
        )}
        <div className="screen-footer">
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className="btn pbtn on-accent" disabled={!input.displayName.trim()} onClick={() => (step === 1 ? setStep(2) : join())}>
            {step === 1 ? 'Continue' : 'Join session'}
          </button>
        </div>
      </div>
    </div>
  );
}
