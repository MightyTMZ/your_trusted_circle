import { useState } from 'react';
import { COPY } from '../copy';
import { useApp } from '../context';

export function StartScreen() {
  const { go, state } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const join = () => {
    const c = code.trim().toUpperCase();
    if (!state.session || state.session.code !== c || state.session.status === 'ended') {
      setError('No active session found for that code.');
      return;
    }
    go({ name: 'join', code: c });
  };

  return (
    <div className="screen">
      <div className="stack" style={{ marginTop: 32 }}>
        <span className="eyebrow">{COPY.appTagline}</span>
        <h1 className="title">A buddy system for nights out that can ask for help when you can't.</h1>
        <p className="lead">One sober host keeps watch. Everyone else joins on their own phone and chooses what they share.</p>
      </div>

      <div className="stack-lg">
        <button className="btn btn-primary btn-block btn-large" onClick={() => go({ name: 'host-setup' })}>
          Host a session
        </button>
        <div className="stack">
          <label className="label" htmlFor="code">
            Or join with a code
          </label>
          <div className="row">
            <input
              id="code"
              className="input code-input"
              maxLength={6}
              value={code}
              placeholder="ABC123"
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && join()}
            />
            <button className="btn btn-secondary" onClick={join} disabled={code.trim().length < 6}>
              Join
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      </div>

      <div className="screen-footer">
        <p className="tiny">{COPY.prototypeNotice}</p>
      </div>
    </div>
  );
}
