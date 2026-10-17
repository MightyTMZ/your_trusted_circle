import { useState } from 'react';
import { joinSession, type ParticipantInput } from '../../domain/session';
import { useApp } from '../context';
import { ParticipantConsentFields, defaultParticipantInput } from '../components/ParticipantConsentFields';

export function JoinSessionScreen({ code }: { code: string }) {
  const { state, store, setViewer, go } = useApp();
  const [input, setInput] = useState<ParticipantInput>(defaultParticipantInput);
  const [error, setError] = useState<string | null>(null);
  const session = state.session;

  if (!session || session.code !== code || session.status === 'ended') {
    return (
      <div className="screen">
        <h1 className="title">This session isn't available</h1>
        <p className="lead">It may have ended or expired. Ask the host for a new QR code.</p>
        <div className="screen-footer">
          <button className="btn btn-secondary btn-block" onClick={() => go({ name: 'home' })}>
            Back
          </button>
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
      <div className="stack">
        <span className="eyebrow">Join session</span>
        <h1 className="title">{session.name}</h1>
        <p className="lead">
          Hosted by {host?.displayName}. They've agreed to stay sober and reachable, and they get alerts first.
        </p>
      </div>

      <ParticipantConsentFields value={input} onChange={setInput} checkInWindowSec={session.config.checkInWindowSec} />

      <div className="screen-footer">
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={!input.displayName.trim()} onClick={join}>
          Join session
        </button>
        <p className="tiny">
          You can change what you share or leave at any time. The session ends automatically.
        </p>
      </div>
    </div>
  );
}
