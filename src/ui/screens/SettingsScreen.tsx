import { useRef, useState } from 'react';
import { emptyState } from '../../domain/session';
import type { AppState } from '../../domain/types';
import { EXPORT_URL, PROVIDER_LABEL, deleteAccount, signOut, toAvatarDataUrl, updateProfile } from '../api';
import { COPY } from '../copy';
import { useApp } from '../context';
import { Avatar, ScreenHeader } from '../components/Controls';
import { Icon, type IconName } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { THEMES, loadTheme, saveTheme, type ThemeId } from '../theme';

/** Everything this device holds about one participant, for the offline export. */
function deviceDataFor(state: AppState, participantId: string) {
  const p = state.participants[participantId];
  return {
    format: 'ytc-device-data-export',
    exportedAt: new Date().toISOString(),
    note: 'Stored only in this browser. Nothing was sent to a server.',
    session: state.session ? { name: state.session.name, createdAt: state.session.createdAt, expiresAt: state.session.expiresAt } : null,
    participant: p,
    checkIns: state.checkIns.filter((c) => c.participantId === participantId),
    observations: state.observations.filter((o) => o.participantId === participantId),
    incidentsAboutMe: state.incidents.filter((i) => i.participantId === participantId),
  };
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Row({ icon, label, sub, onClick, href }: { icon: IconName; label: string; sub?: string; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <span className="av fill">
        <Icon name={icon} />
      </span>
      <span className="stack grow">
        <span className="t-name">{label}</span>
        {sub && <span className="t-sub">{sub}</span>}
      </span>
      <span className="chev">
        <Icon name="chevronRight" />
      </span>
    </>
  );
  return href ? (
    <a className="btn lrow" href={href} download style={{ textDecoration: 'none' }}>
      {body}
    </a>
  ) : (
    <button type="button" className="btn lrow" onClick={onClick}>
      {body}
    </button>
  );
}

type SheetKind = 'clear' | 'signout' | 'delete' | null;

export function SettingsScreen() {
  const { state, me, store, setViewer, go, account, refreshAccount } = useApp();
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const savePhoto = async (avatar: string | null) => {
    setSaving(true);
    setPhotoError(null);
    const result = await updateProfile({ avatar });
    setSaving(false);
    if (typeof result === 'string') setPhotoError(result);
    else void refreshAccount();
  };
  const changePhoto = async (file: File) => {
    try {
      await savePhoto(await toAvatarDataUrl(file));
    } catch {
      setPhotoError("That picture couldn't be used. Try a PNG, JPEG or WebP image.");
    }
  };

  const pick = (id: ThemeId) => {
    setTheme(id);
    saveTheme(id);
  };
  const close = () => {
    setSheet(null);
    setConfirmText('');
    setError(null);
  };

  const profileName = account?.displayName ?? me?.displayName;
  const profileSub = account
    ? [account.email, ...account.providers.map((p) => PROVIDER_LABEL[p])].filter(Boolean).join(' · ')
    : me && state.session
      ? `${me.id === state.session.hostId ? 'Host' : 'Participant'} · ${state.session.name}`
      : 'Not signed in';

  return (
    <div className="screen">
      <div className="narrow">
        {/* On phones Settings opens from a header gear, so it always offers a way back. */}
        <ScreenHeader title="Settings" onBack={() => go({ name: 'home' })} />

        <section className="surface card rise" aria-label="Profile" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="header">
            {profileName ? (
              <Avatar name={profileName} src={account?.avatar} size={56} />
            ) : (
              <span className="av fill" style={{ width: 56, height: 56 }}>
                <Icon name="user" />
              </span>
            )}
            <span className="stack grow">
              <span className="t-card">{profileName ?? 'Guest'}</span>
              <span className="t-sub">{profileSub}</span>
            </span>
            {account === null && (
              <button type="button" className="btn chip fill" onClick={() => go({ name: 'signin' })}>
                Sign in
              </button>
            )}
          </div>
          {account && (
            <div className="inline">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void changePhoto(file);
                }}
              />
              <button type="button" className="btn chip fill" disabled={saving} onClick={() => fileInput.current?.click()}>
                <Icon name="camera" />
                {account.avatar ? 'Change photo' : 'Add photo'}
              </button>
              {account.avatar && (
                <button type="button" className="btn chip fill" disabled={saving} onClick={() => void savePhoto(null)}>
                  Remove
                </button>
              )}
            </div>
          )}
          {photoError && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {photoError}
            </p>
          )}
        </section>

        <section className="fgroup rise rise-2" aria-labelledby="theme-h">
          <h2 className="lbl" id="theme-h">
            Theme
          </h2>
          <div className="theme-grid" role="radiogroup" aria-labelledby="theme-h">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={`btn theme-opt ${theme === t.id ? 'is-sel' : ''}`}
                onClick={() => pick(t.id)}
              >
                <span className="tp" data-theme={t.id} aria-hidden="true">
                  <span className="material tp-bar">
                    <span className="tp-dot" />
                    <span className="tp-line" />
                  </span>
                </span>
                <span className="spread" style={{ padding: '0 4px 2px' }}>
                  <span className="t-name">{t.name}</span>
                  <span className="radio" style={{ width: 18, height: 18 }}>
                    <Icon name="check" />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="fgroup rise rise-3" aria-labelledby="data-h">
          <h2 className="lbl" id="data-h">
            Your data
          </h2>
          <div className="surface card card-list">
            {account ? (
              <Row icon="download" label="Download a copy of your data" href={EXPORT_URL} />
            ) : (
              me && (
                <Row
                  icon="download"
                  label="Download data on this device"
                  onClick={() => download('ytc-device-data.json', deviceDataFor(state, me.id))}
                />
              )
            )}
            <Row
              icon="trash"
              label="Delete data on this device"
              sub={cleared ? 'Deleted.' : undefined}
              onClick={() => setSheet('clear')}
            />
          </div>
        </section>

        <section className="fgroup rise rise-4" aria-labelledby="account-h">
          <h2 className="lbl" id="account-h">
            Account
          </h2>
          <div className="surface card card-list">
            {account ? (
              <>
                <Row icon="logOut" label="Sign out" onClick={() => setSheet('signout')} />
                <Row icon="trash" label="Delete account" onClick={() => setSheet('delete')} />
              </>
            ) : (
              <Row icon="user" label="Sign in or create an account" onClick={() => go({ name: 'signin' })} />
            )}
          </div>
        </section>

        <p className="t-cap center">{COPY.prototypeNotice}</p>
      </div>

      {sheet === 'clear' && (
        <Sheet title="Delete data on this device?" onClose={close}>
          <p className="t-lead">Removes every session, check-in and alert stored in this browser. You'll leave any session you're in.</p>
          <button
            type="button"
            className="btn pbtn fill"
            onClick={() => {
              store.dispatch((d) => void Object.assign(d, emptyState()));
              setViewer(null);
              setCleared(true);
              close();
              go({ name: 'settings' });
            }}
          >
            Delete data
          </button>
          <button type="button" className="btn pbtn fill" onClick={close}>
            Cancel
          </button>
        </Sheet>
      )}

      {sheet === 'signout' && (
        <Sheet title="Sign out?" onClose={close}>
          <p className="t-lead">You'll need to sign in again to host or join a session.</p>
          <button
            type="button"
            className="btn pbtn on-accent"
            onClick={async () => {
              if (await signOut()) {
                void refreshAccount();
                close();
              } else setError("Couldn't reach the server. Try again.");
            }}
          >
            Sign out
          </button>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button type="button" className="btn pbtn fill" onClick={close}>
            Cancel
          </button>
        </Sheet>
      )}

      {sheet === 'delete' && (
        <Sheet title="Delete your account?" onClose={close}>
          <p className="t-lead">
            This permanently deletes your account and everything stored about you, including sessions you host. It can't be undone.
          </p>
          <div className="fgroup">
            <label className="lbl" htmlFor="confirm-delete">
              Type DELETE to confirm
            </label>
            <input id="confirm-delete" className="field" autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button
            type="button"
            className="btn pbtn fill"
            disabled={confirmText !== 'DELETE'}
            onClick={async () => {
              if (await deleteAccount()) {
                void refreshAccount();
                setViewer(null);
                close();
              } else setError("Couldn't delete the account. Try again.");
            }}
          >
            Delete account
          </button>
          <button type="button" className="btn pbtn fill" onClick={close}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
