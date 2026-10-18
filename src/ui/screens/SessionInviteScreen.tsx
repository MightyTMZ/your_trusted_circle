import { useState } from 'react';
import { useApp } from '../context';
import { initials } from '../components/Controls';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';

export function joinUrl(code: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#join=${code}`;
}

export function SessionInviteScreen() {
  const { state, go } = useApp();
  const [copied, setCopied] = useState(false);
  const session = state.session!;
  const url = joinUrl(session.code);
  const joined = Object.values(state.participants).filter((p) => p.status === 'active' && p.role === 'participant');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="screen">
      <div className="narrow">
        <header className="stack center" style={{ gap: 4, alignItems: 'center' }}>
          <h1 className="t-title">Invite your group</h1>
          <span className="t-sub">Scan to join {session.name}</span>
        </header>
        <section className="surface card rise" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: 24 }}>
          <QrCode value={url} label={`QR code to join session ${session.code}`} />
          <div className="stack" style={{ alignItems: 'center', gap: 6 }}>
            <span className="t-sub">Or enter this code</span>
            <span className="t-hero num" style={{ letterSpacing: '0.14em' }} aria-label={`Join code ${session.code.split('').join(' ')}`}>
              {session.code}
            </span>
          </div>
        </section>
        <div className="inline rise rise-2" style={{ justifyContent: 'center', gap: 12 }} role="status">
          {joined.length > 0 && (
            <span className="av-stack" aria-hidden="true">
              {joined.slice(0, 5).map((p, i, list) => (
                <span key={p.id} className="av" style={{ zIndex: list.length - i }}>
                  {initials(p.displayName)}
                </span>
              ))}
            </span>
          )}
          <span className="t-body num">
            {joined.length === 0 ? 'Nobody has joined yet' : `${joined.length} ${joined.length === 1 ? 'person has' : 'people have'} joined`}
          </span>
        </div>
        <div className="screen-footer">
          <button type="button" className="btn pbtn fill" onClick={copy}>
            <Icon name="copy" />
            {copied ? 'Link copied' : 'Copy join link'}
          </button>
          <button type="button" className="btn pbtn on-accent" onClick={() => go({ name: 'home' })}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
