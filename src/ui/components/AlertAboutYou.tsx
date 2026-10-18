import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { activeIncidentFor } from '../../domain/incident';
import { participantUpdate } from '../../domain/session';
import { sendImOkOnServer } from '../api';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { useLive } from '../hooks/useServerSession';
import { useFirstContact } from './HelpSheet';
import { Icon } from './Icon';

/** Alerts the person shrank while still waiting, so screen changes don't reopen them. */
const shrunk = new Set<string>();
/** How long "Okay, understood" stays open before it shrinks into the pill. */
const CONFIRM_MS = 4000;

/**
 * An open alert about you, floating at the top centre of the screen over the
 * page (no layout space).
 *
 * - Waiting for "I'm OK": the full card, outlined in red, with the status and
 *   "Tell responders I'm OK" (which only adds to the alert's record). The
 *   close button shrinks it to the red "Alert about you" pill.
 * - Once the record shows "I'm OK": it turns green (the message reached
 *   responders), says "Okay, understood", and after a few seconds shrinks
 *   into the green pill. Tapping the pill opens it again.
 *
 * Neither state closes the alert or says anything about the person's
 * condition. It stays until a responder resolves the alert.
 */
export function AlertAboutYou() {
  const { state, me, store } = useApp();
  const live = useLive();
  const firstContact = useFirstContact();
  const incident = me ? activeIncidentFor(state, me.id) : undefined;
  // Grounded in the record: the server (or this device) logged the update.
  const said = incident?.timeline
    .filter((e) => e.source === 'participant' && e.kind === 'checkin' && (/responded ["']I'm OK["']/i.test(e.text) || /says they are OK/i.test(e.text)))
    .at(-1);
  const [open, setOpen] = useState(() => !!incident && !said && !shrunk.has(incident.id));
  const close = () => {
    if (incident && !said) shrunk.add(incident.id);
    setOpen(false);
  };
  // "I'm OK" just reached the record: show the confirmation, then shrink into the pill.
  const saidAt = said?.at;
  const seen = useRef(saidAt);
  useEffect(() => {
    if (saidAt === undefined || saidAt === seen.current) return;
    seen.current = saidAt;
    setOpen(true);
    const id = window.setTimeout(() => setOpen(false), CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [saidAt]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  // The card is laid out once at full size; the pill is a window onto its top centre.
  // Opening grows the window, so nothing inside ever moves or resizes.
  const [box, setBox] = useState({ x: 0, h: 44 });
  useLayoutEffect(() => {
    const el = card.current;
    const pill = label.current;
    if (!el || !pill) return;
    // Only a real change updates state; a new object every time would re-render forever.
    const measure = () => {
      const next = { x: Math.max(0, (el.offsetWidth - pill.offsetWidth) / 2), h: el.offsetHeight };
      setBox((prev) => (prev.x === next.x && prev.h === next.h ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(pill);
    return () => ro.disconnect();
  });
  // Escape shrinks it back, like closing any other expanded view.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!incident || !me) return null;

  const session = state.session;
  const isHost = me.id === session?.hostId;
  const status = incident.acknowledged
    ? `${incident.acknowledged.name} acknowledged at ${fmtTime(incident.acknowledged.at)} and is responding.`
    : `${firstContact[0].toUpperCase()}${firstContact.slice(1)} ${isHost ? 'were' : 'was'} alerted at ${fmtTime(incident.openedAt)}.`;
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      if (!incident.server || !session?.serverId) {
        setError(store.dispatch((d, t) => participantUpdate(d, me.id, t)));
        return;
      }
      const r = await sendImOkOnServer(session.serverId);
      if (r.ok) await live.refreshAlerts();
      else setError(r.message);
    } finally {
      setSending(false);
    }
  };

  const vars = { '--island-x': `${box.x}px`, '--island-h': `${box.h}px` } as CSSProperties;
  return createPortal(
    <>
      <section
        ref={card}
        className={`alert-island ${open ? 'is-open' : ''} ${said ? 'is-ok' : ''}`}
        style={vars}
        role={open ? 'dialog' : undefined}
        aria-labelledby={titleId}
      >
        {/* The outlined shape grows from the pill to the card; the content is revealed with it. */}
        <span className="material alert-island-shape" aria-hidden="true" />
        <div className="alert-island-content">
          <div className="alert-island-head">
            <span ref={label} className="alert-island-label">
              <Icon name="bell" size={18} />
              <span id={titleId}>Alert about you</span>
            </span>
            <button type="button" className="btn alert-island-close" aria-label="Close" tabIndex={open ? 0 : -1} onClick={close}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="alert-island-body" aria-hidden={!open}>
            {!said && <p className="t-name">An alert about you is open</p>}
            <p className="t-sub num">{status}</p>
            {said ? (
              <div className="confirm" role="status">
                <Icon name="circleCheck" size={20} />
                <span className="stack">
                  <span className="t-name">Okay, understood</span>
                  <span className="t-cap num">
                    Your responders have been told you said you're OK ({fmtTime(said.at)}). The alert stays open until one of them resolves it.
                  </span>
                </span>
              </div>
            ) : (
              <>
                <button type="button" className="btn pbtn on-accent" disabled={sending || !open} tabIndex={open ? 0 : -1} onClick={send}>
                  {sending ? 'Sending…' : "Tell responders I'm OK"}
                </button>
                <p className="t-cap">Adds to the alert's record. It does not close the alert.</p>
              </>
            )}
            {error && (
              <p className="error" role="alert">
                <Icon name="alert" />
                {error}
              </p>
            )}
          </div>
        </div>
        {/* Collapsed, only the pill is tappable; the rest of the hidden card lets taps through. */}
        {!open && (
          <button
            type="button"
            className="btn alert-island-hit"
            aria-expanded={false}
            aria-label={said ? 'Alert about you is open. You told responders you are OK.' : 'An alert about you is open'}
            onClick={() => setOpen(true)}
          />
        )}
      </section>
    </>,
    document.body,
  );
}
