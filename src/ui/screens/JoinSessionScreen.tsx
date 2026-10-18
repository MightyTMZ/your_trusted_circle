import { useState, useEffect } from 'react';
import { joinSession, hydrateServerSession, type ParticipantInput } from '../../domain/session';
import { previewSession, joinSessionOnServer, type SessionPreview } from '../api';
import { useApp } from '../context';
import { ScreenHeader, StepBar, initials } from '../components/Controls';
import { Icon } from '../components/Icon';
import { ParticipantConsentFields, defaultParticipantInput } from '../components/ParticipantConsentFields';

export function JoinSessionScreen({ code }: { code: string }) {
  const { state, store, setViewer, go, account, setPendingJoinCode } = useApp();
  const [step, setStep] = useState(1);
  const [input, setInput] = useState<ParticipantInput>(() => ({ ...defaultParticipantInput(), displayName: account?.displayName ?? '' }));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null | undefined>(undefined);
  const [joining, setJoining] = useState(false);

  // The account may arrive after the screen opens; use its name if none was typed yet.
  const accountName = account?.displayName;
  useEffect(() => {
    if (accountName) setInput((v) => (v.displayName ? v : { ...v, displayName: accountName }));
  }, [accountName]);

  // If the user isn't signed in, save the code and redirect to sign-in.
  useEffect(() => {
    if (account === null) {
      setPendingJoinCode(code);
      go({ name: 'signin' });
    }
  }, [account, code, setPendingJoinCode, go]);

  // Fetch session preview from server.
  useEffect(() => {
    if (account === undefined || account === null) return;
    let alive = true;
    previewSession(code).then((p) => alive && setPreview(p));
    return () => { alive = false; };
  }, [code, account]);

  // While account is loading or redirecting, show nothing.
  if (account === undefined || account === null) return null;

  // Use server preview; use client state for same-device hosts as a backup.
  const localSession = state.session;
  const hasLocal = localSession && localSession.code === code && localSession.status !== 'ended';

  if (preview === undefined) {
    return (
      <div className="screen">
        <div className="narrow">
          <ScreenHeader title="Join session" onBack={() => go({ name: 'home' })} />
          <p className="t-sub" style={{ textAlign: 'center', marginTop: 48 }}>Loading session…</p>
        </div>
      </div>
    );
  }

  if (!preview && !hasLocal) {
    return (
      <div className="screen">
        <div className="narrow">
          <ScreenHeader title="Join session" onBack={() => go({ name: 'home' })} />
          <div className="surface card stack" style={{ gap: 8 }}>
            <h2 className="t-card">This session isn't available</h2>
            <p className="t-sub">It may have ended or expired. Ask the host for a new QR code.</p>
          </div>
        </div>
      </div>
    );
  }

  const sessionName = preview?.name ?? localSession!.name;
  const hostName = preview?.hostName ?? (localSession ? state.participants[localSession.hostId]?.displayName : null);
  const checkInWindowSec = preview?.rules?.checkInWindowSec ?? localSession?.config?.checkInWindowSec ?? 60;

  const join = async () => {
    setJoining(true);
    setError(null);

    // Join on server.
    const result = await joinSessionOnServer({
      code,
      consent: {
        monitoring: input.motionMonitoring,
        locationSharing: input.locationSharing,
        shareLocationWithResponders: input.shareLocationWithResponders,
        shareNoteWithResponders: input.shareNoteWithResponders,
        consentTextVersion: 'consent-v1',
      },
      ...(input.emergencyNote.trim() ? { responderNote: input.emergencyNote.trim().slice(0, 500) } : {}),
      backupContacts: input.backupContacts.filter((c) => c.name.trim() && c.relation.trim()).map((c) => ({ name: c.name.trim(), relation: c.relation.trim() })),
    });

    if (typeof result === 'string') {
      setJoining(false);
      return setError(result);
    }

    // If the host is on this same device, join locally too.
    if (hasLocal) {
      let id = '';
      const err = store.dispatch((d, now) => {
        id = joinSession(d, code, input, now).id;
        // In the same browser the server sees the same account, so only link an id nobody here has yet.
        const sid = result.me?.participantId;
        if (sid && !Object.values(d.participants).some((x) => x.serverId === sid)) d.participants[id].serverId = sid;
      });
      if (err) { setJoining(false); return setError(err); }
      setViewer({ kind: 'participant', id });
      return;
    }

    // Cross-device: hydrate client state from server response.
    let myId = '';
    store.dispatch((d, now) => {
      myId = hydrateServerSession(d, { serverSession: result, code, myInput: input }, now);
    });
    setViewer({ kind: 'participant', id: myId });
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
        <section className="surface card rise" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="av fill">{initials(hostName ?? '?')}</span>
          <span className="stack grow">
            <span className="t-card">{sessionName}</span>
            <span className="t-sub">Hosted by {hostName ?? 'someone'} · Stays sober and gets alerts first</span>
          </span>
        </section>
        {step === 1 ? (
          <div className="narrow rise rise-2" key="j1">
            <ParticipantConsentFields value={input} onChange={setInput} checkInWindowSec={checkInWindowSec} part="basics" />
          </div>
        ) : (
          <div className="narrow rise" key="j2">
            <ParticipantConsentFields value={input} onChange={setInput} checkInWindowSec={checkInWindowSec} part="responders" />
          </div>
        )}
        <div className="screen-footer">
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className="btn pbtn on-accent" disabled={!input.displayName.trim() || joining} onClick={() => (step === 1 ? setStep(2) : join())}>
            {joining ? 'Joining…' : step === 1 ? 'Continue' : 'Join session'}
          </button>
        </div>
      </div>
    </div>
  );
}
