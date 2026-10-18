import { useState } from 'react';
import { COPY } from '../copy';
import { useApp } from '../context';
import { Avatar } from '../components/Controls';
import { Icon } from '../components/Icon';

export function StartScreen() {
  const { go, account } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ready = code.trim().length === 6;
  const join = () => {
    const c = code.trim().toUpperCase();
    if (c.length < 6) {
      setError('Enter a 6-character join code.');
      return;
    }
    go({ name: 'join', code: c });
  };
  return (
    <div className="screen">
      <div className="narrow">
        <div className="spread">
          <div className="logo" role="img" aria-label="YTC" style={{ width: 56, height: 56 }} />
          <span className="inline">
            {account ? (
              <button type="button" className="btn chip fill" onClick={() => go({ name: 'settings' })} style={{ gap: 8 }}>
                <Avatar name={account.displayName} src={account.avatar} size={24} />
                {account.displayName}
              </button>
            ) : (
              <button type="button" className="btn chip fill" onClick={() => go({ name: 'signin' })}>
                Sign in
              </button>
            )}
            <button type="button" className="btn ibtn fill" aria-label="Settings" onClick={() => go({ name: 'settings' })}>
              <Icon name="settings" />
            </button>
          </span>
        </div>
        <div className="stack rise rise-2" style={{ gap: 12 }}>
          <span className="t-sub">{COPY.appTagline}</span>
          <h1 className="t-display">A buddy system for nights out that can ask for help when you can't.</h1>
          <p className="t-lead">One sober host keeps watch. Everyone else joins on their own phone and shares their location with the group or just the host.</p>
        </div>
        <div className="screen-footer rise rise-3">
          <button type="button" className="btn pbtn on-accent" onClick={() => go({ name: 'host-setup' })}>
            Host a session
          </button>
          <div className="fill inputbar">
            <label htmlFor="code" className="sr-only">
              Join code
            </label>
            <input
              id="code"
              className="field field-bare code-input num"
              maxLength={6}
              autoComplete="off"
              value={code}
              placeholder="Join code"
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && ready && join()}
            />
            <button type="button" className={`btn ibtn ${ready ? 'on-accent' : 'fill'}`} aria-label="Join session" disabled={!ready} onClick={join}>
              <Icon name="arrowRight" />
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
