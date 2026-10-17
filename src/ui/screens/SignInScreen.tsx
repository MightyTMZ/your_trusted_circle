import { useEffect, useState } from 'react';
import { PROVIDERS, PROVIDER_LABEL, fetchProviders, signInUrl, takeLoginError, type Provider } from '../api';
import { useApp } from '../context';
import { ScreenHeader } from '../components/Controls';
import { Icon } from '../components/Icon';

/**
 * Sign in and sign up are one flow: the server creates the account on the
 * first sign-in with a provider. Shows only providers the server has configured.
 */
export function SignInScreen() {
  const { go } = useApp();
  const [providers, setProviders] = useState<Provider[] | null | undefined>(undefined);
  const [error] = useState(takeLoginError);

  useEffect(() => {
    let alive = true;
    fetchProviders().then((p) => alive && setProviders(p));
    return () => {
      alive = false;
    };
  }, []);

  const unavailable = providers === null || (providers !== undefined && providers.length === 0);
  const shown: readonly Provider[] = providers && providers.length > 0 ? providers : PROVIDERS;

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader title="Sign in" onBack={() => go({ name: 'home' })} />
        <div className="stack rise" style={{ gap: 8 }}>
          <div className="logo glass" role="img" aria-label="YTC" style={{ width: 56, height: 56, fontSize: 12, marginBottom: 16 }}>
            YTC
          </div>
          <h2 className="t-display">Sign in or create an account</h2>
          <p className="t-lead">New to YTC? Your account is created the first time you sign in.</p>
        </div>
        <div className="screen-footer rise rise-2">
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
          {shown.map((p) => (
            <a
              key={p}
              className="btn pbtn glass"
              href={unavailable || providers === undefined ? undefined : signInUrl(p)}
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
