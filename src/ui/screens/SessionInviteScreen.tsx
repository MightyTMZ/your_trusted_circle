import { useState } from 'react';
import { COPY } from '../copy';
import { useApp } from '../context';
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
  const joined = Object.values(state.participants).filter((p) => p.status === 'active' && p.role === 'participant').length;

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
      <div className="stack">
        <span className="eyebrow">Invite your group</span>
        <h1 className="title">Scan to join {session.name}</h1>
      </div>

      <QrCode value={url} label={`QR code to join session ${session.code}`} />
      <div className="stack" style={{ alignItems: 'center' }}>
        <span className="tiny">Or enter this code</span>
        <span className="join-code" aria-label={`Join code ${session.code.split('').join(' ')}`}>
          {session.code}
        </span>
      </div>

      <p className="small">{COPY.hostCannotEnable}</p>

      <div className="screen-footer">
        <p className="small" style={{ textAlign: 'center' }}>
          {joined === 0 ? 'Nobody has joined yet.' : `${joined} ${joined === 1 ? 'person has' : 'people have'} joined.`}
        </p>
        <button className="btn btn-secondary btn-block" onClick={copy}>
          {copied ? 'Link copied' : 'Copy join link'}
        </button>
        <button className="btn btn-primary btn-block" onClick={() => go({ name: 'home' })}>
          Done
        </button>
      </div>
    </div>
  );
}
