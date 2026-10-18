import { useEffect, useState } from 'react';
import { PROVIDERS, PROVIDER_LABEL, fetchProviders, fetchTestSignInEnabled, signInUrl, takeLoginError, testSignIn, type Provider } from '../api';
import { useApp } from '../context';
import { ScreenHeader } from '../components/Controls';
import { Icon } from '../components/Icon';
import { SafetyNet } from '../components/SafetyNet';

/**
 * Sign in and sign up are one flow: the server creates the account on the
 * first sign-in with a provider. Shows only providers the server has configured.
 */
export function SignInScreen() {
  const { go, pendingJoinCode, setPendingJoinCode, refreshAccount } = useApp();
  const [providers, setProviders] = useState<Provider[] | null | undefined>(undefined);
  const [error] = useState(takeLoginError);
  const [testOn, setTestOn] = useState(false);
  const [testName, setTestName] = useState('');
  const [testError, setTestError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const returnTo = pendingJoinCode ? `/#join=${pendingJoinCode}` : '/';

  useEffect(() => {
    let alive = true;
    fetchProviders().then((p) => alive && setProviders(p));
    fetchTestSignInEnabled().then((on) => alive && setTestOn(on));
    return () => {
      alive = false;
    };
  }, []);

  const unavailable = !testOn && (providers === null || (providers !== undefined && providers.length === 0));
  const noRealProviders = !providers || providers.length === 0;

  const signInAsTest = async () => {
    setSigningIn(true);
    setTestError(null);
    const err = await testSignIn(testName);
    if (err) {
      setSigningIn(false);
      return setTestError(err);
    }
    await refreshAccount();
    const code = pendingJoinCode;
    setPendingJoinCode(null);
    go(code ? { name: 'join', code } : { name: 'home' });
  };
  const shown: readonly Provider[] = providers && providers.length > 0 ? providers : PROVIDERS;

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader title="Sign in" onBack={() => { setPendingJoinCode(null); go({ name: 'home' }); }} />
        <div className="stack rise" style={{ gap: 8 }}>
          <div className="logo" role="img" aria-label="YTC" style={{ width: 56, height: 56, marginBottom: 16 }} />
          <h2 className="t-display">Sign in or create an account</h2>
          <p className="t-lead">
            {pendingJoinCode
              ? 'Sign in to join the session. Your account is created the first time you sign in.'
              : 'New to YTC? Your account is created the first time you sign in.'}
          </p>
        </div>
        <SafetyNet height={240} className="rise rise-2" />
        <div className="rise rise-2">
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          {unavailable && (
            <p className="error" role="status">
              <Icon name="alert" />
              {providers === null
                ? "Sign-in needs the YTC server, which isn't reachable right now."
                : 'No sign-in providers are set up on this server yet.'}
            </p>
          )}
          {testOn && (
            <section className="surface card stack" style={{ gap: 12 }} aria-labelledby="test-signin-h">
              <span className="stack" style={{ gap: 2 }}>
                <span className="inline">
                  <h2 className="t-card grow" id="test-signin-h">
                    Test sign-in
                  </h2>
                  <span className="tag">This computer only</span>
                </span>
                <span className="t-sub">For trying YTC with made-up people. No password. Give each person their own browser, private window, or address (localhost and 127.0.0.1 count as two).</span>
              </span>
              <label className="sr-only" htmlFor="test-name">
                Test name
              </label>
              <input
                id="test-name"
                className="field"
                value={testName}
                placeholder="Made-up name, e.g. Sam Test"
                autoComplete="off"
                maxLength={40}
                onChange={(e) => setTestName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && testName.trim() && !signingIn && signInAsTest()}
              />
              {testError && (
                <p className="error" role="alert">
                  <Icon name="alert" />
                  {testError}
                </p>
              )}
              <button
                type="button"
                className={`btn pbtn ${noRealProviders ? 'on-accent' : 'fill'}`}
                disabled={!testName.trim() || signingIn}
                onClick={signInAsTest}
              >
                {signingIn ? 'Signing in…' : 'Sign in as test person'}
              </button>
            </section>
          )}
          {!(testOn && noRealProviders) && shown.map((p) => (
            <a
              key={p}
              className="btn pbtn fill"
              href={unavailable || providers === undefined ? undefined : signInUrl(p, returnTo)}
              aria-disabled={unavailable || providers === undefined}
              style={unavailable || providers === undefined ? { opacity: 0.4, pointerEvents: 'none' } : { textDecoration: 'none' }}
            >
              Continue with {PROVIDER_LABEL[p]}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
