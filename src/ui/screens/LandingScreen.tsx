import { useState } from 'react';
import { COPY } from '../copy';
import { useApp } from '../context';
import { Avatar } from '../components/Controls';
import { Icon } from '../components/Icon';

// One short line each: the verb first, no mechanism. Setup explains the rest when it matters.
const STEPS = [
  { title: 'Create a session', body: 'Name it and set how long it runs.' },
  { title: 'Friends join', body: 'They scan a QR code and choose what to share.' },
  { title: 'Check-ins keep watch', body: 'A missed check-in alerts the host first.' },
];

/** First screen for a visitor: what YTC is, how it works in three lines, and one big way to start. Account and settings sit where they do everywhere else. */
export function LandingScreen() {
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
      <div className="narrow" style={{ maxWidth: 960 }}>
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

        <div className="cols" style={{ gap: 32 }}>
          <div className="col" style={{ gap: 24 }}>
            <div className="stack" style={{ gap: 12 }}>
              <span className="t-sub">{COPY.appTagline}</span>
              <h1 className="t-display" style={{ textWrap: 'balance' }}>
                A buddy system for nights out.
              </h1>
            </div>

            <div className="stack" style={{ gap: 12 }}>
              <button type="button" className="btn pbtn on-accent" style={{ minHeight: 68, fontSize: 20 }} onClick={() => go({ name: 'host-setup' })}>
                Create a session
              </button>
              <div className="fill inputbar">
                <label htmlFor="landing-code" className="sr-only">
                  Join code
                </label>
                <input
                  id="landing-code"
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

          <div className="col">
            <section className="surface card card-list" aria-labelledby="how-h">
              <div className="card-head">
                <h2 className="t-card" id="how-h">
                  How it works
                </h2>
              </div>
              <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {STEPS.map((s, i) => (
                  <li key={s.title} className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <span className="t-card num" style={{ width: 20, flex: 'none' }} aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="stack grow" style={{ gap: 4 }}>
                      <span className="t-name">{s.title}</span>
                      <span className="t-sub">{s.body}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
            <p className="t-cap">{COPY.prototypeNotice}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
