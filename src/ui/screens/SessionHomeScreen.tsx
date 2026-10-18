import { useEffect, useRef, useState } from 'react';
import { UNVALIDATED_LABEL } from '../../domain/config';
import { GROUP_RECIPIENT_PREFIX, HOST_RECIPIENT_PREFIX, alertedNames, nextDeadline } from '../../domain/incident';
import { canViewLocation, latestReading, participantFreshness } from '../../domain/location';
import { endSession, resumeSession, suspendSession, updateConsent } from '../../domain/session';
import type { Incident, Participant } from '../../domain/types';
import { COPY } from '../copy';
import { useApp, useNow } from '../context';
import { fmtAgo, fmtCountdown, fmtTime } from '../format';
import { SettingsButton } from '../components/AppNav';
import { initials } from '../components/Controls';
import { LiveScrubber } from '../components/Gauges';
import { GroupMap, liveFixFor, useGroupPoints } from '../components/GroupMap';
import { Icon } from '../components/Icon';
import { LocationStamp } from '../components/LocationStamp';
import { Sheet } from '../components/Sheet';
import { useActivityInference } from '../hooks/useActivityInference';
import { useMotionTracking } from '../hooks/useMotionTracking';
import { useLive } from '../hooks/useServerSession';
import { endSessionOnServer, fetchStory, updateConsentOnServer, type ServerStory, type LiveFix } from '../api';
import { AccessPrompt } from '../components/AccessPrompt';

function fmtHM(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function AlertRow({ incident, now }: { incident: Incident; now: number }) {
  const { state, go } = useApp();
  const p = state.participants[incident.participantId];
  const deadline = nextDeadline(incident);
  const open = incident.status === 'open';
  const status = open
    ? deadline !== undefined
      ? `Unacknowledged · escalates in ${fmtCountdown(deadline - now)}`
      : 'Unacknowledged · all steps alerted'
    : incident.status === 'acknowledged'
      ? `Acknowledged by ${incident.acknowledged?.name} · not yet resolved`
      : incident.resolution?.by === 'participant'
        ? `${COPY.cancelledBySelf(p.displayName)} · ${fmtTime(incident.resolution.at)}`
        : `Resolved ${fmtTime(incident.resolution!.at)}`;
  const title =
    incident.resolution?.by === 'participant'
      ? `${p.displayName} cancelled an alert`
      : incident.trigger === 'help_requested'
        ? `${p.displayName} started an alert`
        : `Alert started for ${p.displayName}`;
  return (
    <button type="button" className={`btn lrow${open ? ' alert-row-open' : ''}`} onClick={() => go({ name: 'alert', id: incident.id })}>
      <span className={`av num ${open ? 'on-danger' : 'fill'}`}>{initials(p.displayName)}</span>
      <span className="stack grow">
        <h2 className="t-card">{title}</h2>
        <span className="t-sub num">{status}</span>
      </span>
      <span className="chev" aria-hidden="true">
        <Icon name="arrowUpRight" />
      </span>
    </button>
  );
}

function AlertList({ incidents, now }: { incidents: Incident[]; now: number }) {
  return (
    <section className="surface card card-list alert-list" aria-label="Alerts">
      {incidents.map((incident) => (
        <AlertRow key={incident.id} incident={incident} now={now} />
      ))}
    </section>
  );
}

/** A relayed device fix, labelled live or last known with its time. */
function LiveFixStamp({ fix, now }: { fix: LiveFix; now: number }) {
  const at = new Date(fix.fixAt).getTime();
  return (
    <span className="inline t-sub num" style={{ gap: 6 }}>
      <span className={`dot ${fix.status === 'live' ? 'live' : 'hollow'}`} aria-hidden="true" />
      {fix.status === 'live' ? (
        <span>
          <span className="t-name" style={{ fontSize: 12 }}>Live</span> · {fix.simulated ? 'Simulated' : `GPS ±${fix.accuracyM} m`} · {fmtTime(at)}
        </span>
      ) : (
        <span>
          <span className="t-name" style={{ fontSize: 12 }}>Stale</span> · last known {fmtTime(at)} · {fmtAgo(Math.max(0, now - at))}
        </span>
      )}
    </span>
  );
}

function PersonRow({ subject, viewer, now, alerting, fixes }: { subject: Participant; viewer: Participant; now: number; alerting: boolean; fixes: LiveFix[] }) {
  const { state } = useApp();
  const session = state.session!;
  const isHostView = viewer.id === session.hostId;
  const fix = liveFixFor(subject, fixes);
  const reading = subject.remote ? undefined : latestReading(subject);
  const visible = canViewLocation(session, viewer, subject);
  let location;
  if (fix) location = <LiveFixStamp fix={fix} now={now} />;
  // Everyone shares with at least the host, and the host with everyone, so no fix usually means no GPS yet.
  else if (subject.remote)
    location = <span className="t-sub">{isHostView || subject.role === 'host' ? COPY.locationNone : COPY.locationNotYetShared}</span>;
  else if (subject.consent.locationSharing === 'off') location = <span className="t-sub">{COPY.locationOff}</span>;
  else if (!visible) location = <span className="t-sub">{COPY.locationNotShared}</span>;
  else if (!reading) location = <span className="t-sub">{COPY.locationNone}</span>;
  else
    location = (
      <LocationStamp
        reading={reading}
        fresh={participantFreshness(subject, reading, now, session.config.locationStaleAfterSec)}
        now={now}
        showPlace={false}
      />
    );
  return (
    <li className="row" style={{ alignItems: 'flex-start' }}>
      <span className={`av num ${alerting ? 'on-danger' : 'fill'}`}>{initials(subject.displayName)}</span>
      <span className="stack grow" style={{ gap: 4 }}>
        <span className="inline">
          <span className="t-name">{subject.id === viewer.id ? `${subject.displayName} (you)` : subject.displayName}</span>
          {subject.role === 'host' && <span className="tag">Host</span>}
          {!subject.device.online && <span className="tag num">Offline {fmtAgo(now - subject.device.changedAt)}</span>}
        </span>
        {location}
        {isHostView && subject.id !== viewer.id && (
          <span className="t-cap">Check-ins {subject.consent.motionMonitoring ? 'on' : 'off'} (their choice)</span>
        )}
      </span>
    </li>
  );
}

function CheckInStatus({ me }: { me: Participant }) {
  const { state, go } = useApp();
  const session = state.session!;
  const b = me.baseline;
  const d = session.config.detector;
  const text = !me.consent.motionMonitoring
    ? 'Off. You can turn them on in your sharing.'
    : session.status === 'suspended'
      ? 'Paused while the host has the session suspended.'
      : b.status === 'calibrating'
        ? `Learning your usual movement · ${b.n}/${d.calibrationSamples} samples`
        : b.status === 'calibrated'
          ? `Baseline set at ${fmtTime(b.calibratedAt!)} · typical ${b.mean!.toFixed(2)} ± ${b.std!.toFixed(2)} m/s²`
          : 'No baseline yet.';
  return (
    <section className="surface card card-list rise rise-4">
      <button type="button" className="btn lrow" onClick={() => go({ name: 'sharing' })}>
        <span className="stack grow">
          <span className="t-name">Your check-ins</span>
          <span className="t-sub num">{text}</span>
          {b.status === 'calibrated' && me.consent.motionMonitoring && (
            <span className="t-cap num">
              Rule: |z| ≥ {d.zThreshold} for {d.consecutiveSamples} samples in a row. {UNVALIDATED_LABEL}.
            </span>
          )}
        </span>
        <span className="chev">
          <Icon name="chevronRight" />
        </span>
      </button>
    </section>
  );
}

export function SessionHomeScreen() {
  const { state, me, store, go, setViewer } = useApp();
  const now = useNow();
  const [sheet, setSheet] = useState<null | 'end'>(null);
  /** A moment on the session's time bar, or null for live. */
  const [lookBack, setLookBack] = useState<number | null>(null);
  /** The moment whose events are open in a sheet, or null. */
  const [moment, setMoment] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = state.session!;
  const viewer = me!;
  const trackingActive = viewer.consent.motionMonitoring && session.status === 'active' && viewer.status === 'active';
  const { permissionState: motionPerm, requestPermission: requestMotion } = useMotionTracking(
    store,
    trackingActive ? viewer.id : null,
  );
  // Activity inference: collects 12 sensor features, runs TFJS model, sends
  // predictions as sensor traces to the MongoDB traces collection.
  useActivityInference(
    trackingActive ? session.serverId ?? null : null,
    trackingActive ? session.serverId ?? null : null,
  );
  const isHost = viewer.id === session.hostId;
  const ended = session.status === 'ended' || viewer.status === 'left';
  const people = Object.values(state.participants).filter((p) => p.status === 'active');
  const alerts = state.incidents
    .filter((i) => i.participantId !== viewer.id)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.openedAt - a.openedAt);
  const recipientId = isHost ? HOST_RECIPIENT_PREFIX + viewer.id : GROUP_RECIPIENT_PREFIX + viewer.id;
  const visibleAlerts = isHost ? alerts : alerts.filter((i) => state.notifications.some((n) => n.incidentId === i.id && n.recipientId === recipientId));
  const alerting = new Set(state.incidents.filter((i) => i.status === 'open').map((i) => i.participantId));
  const hostName = state.participants[session.hostId]?.displayName;
  const latestCancelled = state.incidents
    .filter((i) => i.participantId === viewer.id && i.resolution?.by === 'participant' && now - i.resolution.at < 10 * 60_000)
    .sort((a, b) => b.resolution!.at - a.resolution!.at)[0];
  const [cancelledNotice, setCancelledNotice] = useState<Incident | null>(null);
  const seenCancelledId = useRef<string | null>(latestCancelled?.id ?? null);
  useEffect(() => {
    if (!latestCancelled || latestCancelled.id === seenCancelledId.current) return;
    seenCancelledId.current = latestCancelled.id;
    setCancelledNotice(latestCancelled);
    const id = window.setTimeout(() => setCancelledNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [latestCancelled?.id]);
  const myIncident = state.incidents.find((i) => i.participantId === viewer.id && i.status !== 'resolved');
  const live = useLive();
  const { points, anchor } = useGroupPoints(viewer, now);
  const run = (fn: Parameters<typeof store.dispatch>[0]) => {
    const err = store.dispatch(fn);
    setError(err);
    return !err;
  };
  // Turning check-ins off is the person's own choice (consent); it also syncs to the server.
  const turnOffCheckIns = () => {
    if (!run((d) => updateConsent(d, viewer.id, viewer.id, { motionMonitoring: false }))) return;
    if (session.serverId) {
      void updateConsentOnServer(session.serverId, {
        monitoring: false,
        locationSharing: viewer.consent.locationSharing,
        shareLocationWithResponders: viewer.consent.shareLocationWithResponders,
        shareNoteWithResponders: viewer.consent.shareNoteWithResponders,
        consentTextVersion: 'consent-v1',
      });
    }
  };
  // "Not now" on a blocked-access prompt lasts for this visit only (this tab's session storage).
  const snoozeKey = (what: 'motion' | 'location') => `ytc.accessPrompt.${what}.${session.id}`;
  const readSnooze = (what: 'motion' | 'location') => {
    try {
      return sessionStorage.getItem(snoozeKey(what)) === '1';
    } catch {
      return false;
    }
  };
  const [snoozed, setSnoozed] = useState(() => ({ motion: readSnooze('motion'), location: readSnooze('location') }));
  const snooze = (what: 'motion' | 'location') => {
    setSnoozed((s) => ({ ...s, [what]: true }));
    try {
      sessionStorage.setItem(snoozeKey(what), '1');
    } catch {
      // Lasts until the page reloads.
    }
  };
  const errorBox = error && (
    <p className="error" role="alert">
      <Icon name="alert" />
      {error}
    </p>
  );

  if (ended) {
    return (
      <div className="screen">
        <div className="narrow">
          <header className="stack">
            <span className="t-sub">{session.name}</span>
            <h1 className="t-title">{viewer.status === 'left' ? 'You left the session' : 'This session has ended'}</h1>
          </header>
          <p className="t-lead">Location sharing and check-ins have stopped.</p>
          {visibleAlerts.length > 0 && (
            <section className="col">
              <h2 className="lbl">Alerts from this session</h2>
              <AlertList incidents={visibleAlerts} now={now} />
            </section>
          )}
          <div className="screen-footer">
            <button type="button" className="btn pbtn on-accent" onClick={() => setViewer(null)}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  const simulatedCount = points.filter((pt) => pt.source === 'simulated').length;
  // Nobody is left off silently: say who is missing and why.
  const onMap = new Set(points.map((pt) => pt.participantId));
  const offMap = people.filter((p) => !onMap.has(p.id));
  // Only the host knows others' sharing choices, so for anyone else this never guesses why.
  const offMapReason = (p: (typeof people)[number]) =>
    p.id === viewer.id
      ? live.geo === 'denied' || live.geo === 'unavailable'
        ? 'location is off'
        : 'no position yet'
      : 'no position shared with you yet';

  return (
    <div className="screen">
      <header className="header">
        <span className="logo phone-only" role="img" aria-label="YTC" />
        <h1 className="t-title grow">{session.name}</h1>
        {isHost && (
          <button type="button" className="btn ibtn fill" aria-label="Show QR code" onClick={() => go({ name: 'invite' })}>
            <Icon name="qr" />
          </button>
        )}
        <SettingsButton />
      </header>

      {cancelledNotice && (
        <div className="toast material" role="status" aria-live="polite">
          <Icon name="circleCheck" />
          <span className="stack">
            <span className="t-name">Alert cancelled</span>
            <span className="t-sub">
              Escalation stopped. {alertedNames(state, cancelledNotice)} can see this was a false alarm.
            </span>
          </span>
        </div>
      )}

      {/* Access prompts wait while an alert about you is open: that notification comes first. */}
      {!myIncident && trackingActive && motionPerm === 'prompt' && (
        <AccessPrompt
          icon="activity"
          title="Motion sensor needed"
          primary={{ label: 'Allow motion access', onClick: requestMotion }}
          secondary={{ label: 'Turn off check-ins', onClick: turnOffCheckIns }}
        >
          Check-ins need your phone's motion sensor to notice a sudden change in how you move. The readings stay on this session and are
          only used for your private check-ins.
        </AccessPrompt>
      )}
      {!myIncident && trackingActive && motionPerm === 'denied' && !snoozed.motion && (
        <AccessPrompt
          icon="activity"
          title="Motion access is blocked"
          primary={{ label: 'Reload after allowing', onClick: () => window.location.reload() }}
          secondary={{ label: 'Not now', onClick: () => snooze('motion') }}
        >
          Check-ins can't work without it. Allow motion and orientation access for this site in your browser settings, then reload.
        </AccessPrompt>
      )}
      {!myIncident && !(trackingActive && (motionPerm === 'prompt' || (motionPerm === 'denied' && !snoozed.motion))) && live.geo === 'denied' && !snoozed.location && (
        <AccessPrompt
          icon="mapPin"
          title="Location is off"
          primary={{ label: 'Reload after allowing', onClick: () => window.location.reload() }}
          secondary={{ label: 'Not now', onClick: () => snooze('location') }}
        >
          {isHost ? 'Your group' : 'Your host'} can't see where you are, and responders won't have a last-known location if an alert opens.
          Allow location for this site in your browser settings, then reload.
        </AccessPrompt>
      )}

      <div className="cols">
        <div className="col">
          {visibleAlerts.length > 0 && <AlertList incidents={visibleAlerts} now={now} />}
          <section className="surface card rise rise-2" style={{ padding: 8 }} aria-label="Group map">
            <div style={{ position: 'relative' }}>
              <GroupMap points={points} anchor={anchor} alerting={alerting} />
              <span className="material chip map-chip num">
                {points.length} of {people.length} on map{simulatedCount > 0 ? ` · ${simulatedCount} simulated` : ''}
              </span>
            </div>
            {offMap.length > 0 && (
              <p className="t-cap" style={{ padding: '10px 12px 0' }}>
                Not on the map: {offMap.map((p) => `${p.id === viewer.id ? 'you' : p.displayName} (${offMapReason(p)})`).join(', ')}.
              </p>
            )}
            <div className="stack" style={{ gap: 12, padding: '16px 12px 8px' }}>
              <div className="spread">
                <span className="stack">
                  <span className="t-card">Session</span>
                  <span className="t-sub">{isHost ? "You're the host" : `Host: ${hostName ?? 'unknown'}`}</span>
                </span>
                {isHost && (
                  <span className="inline">
                    {session.status === 'active' ? (
                      <button type="button" className="btn chip fill" onClick={() => run((d, t) => suspendSession(d, viewer.id, t))}>
                        <Icon name="pause" />
                        Suspend
                      </button>
                    ) : (
                      <button type="button" className="btn chip fill" onClick={() => run((d) => resumeSession(d, viewer.id))}>
                        <Icon name="play" />
                        Resume
                      </button>
                    )}
                    <button type="button" className="btn chip fill" onClick={() => setSheet('end')}>
                      End
                    </button>
                  </span>
                )}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <LiveScrubber start={session.createdAt} now={now} at={lookBack} onSeek={setLookBack} label={(t) => `${fmtTime(t)}, ${fmtHM(now - t)} ago`} />
                <div className="spread t-cap num">
                  <span>Started {fmtTime(session.createdAt).slice(0, 5)}</span>
                  <span className="inline">
                  <button type="button" className="btn chip fill live-back" onClick={() => setMoment(lookBack ?? now)}>
                    What happened
                  </button>
                  {lookBack === null ? (
                    <span className="live-tag">
                      <span className="dot live" aria-hidden="true" />
                      Live · {fmtHM(session.expiresAt - now)} left
                    </span>
                  ) : (
                    <button type="button" className="btn chip fill live-back" onClick={() => setLookBack(null)}>
                      −{fmtHM(now - lookBack)} · Back to live
                    </button>
                  )}
                  </span>
                </div>
              </div>
              {session.status === 'suspended' && (
                <p className="t-sub">Location updates and new check-ins are paused for everyone. Open alerts keep escalating.</p>
              )}
            </div>
          </section>
          {errorBox}
        </div>

        <div className="col">
          <section className="surface card card-list rise rise-3" aria-labelledby="people-h">
            <div className="card-head">
              <h2 className="t-card" id="people-h">
                People
              </h2>
              <span className="t-sub num">{people.length}</span>
            </div>
            <ul>
              {people.map((p) => (
                <PersonRow key={p.id} subject={p} viewer={viewer} now={now} alerting={alerting.has(p.id)} fixes={live.fixes} />
              ))}
            </ul>
          </section>
          <CheckInStatus me={viewer} />
        </div>
      </div>

      {moment !== null && <MomentSheet at={moment} live={lookBack === null} onClose={() => setMoment(null)} />}

      {sheet === 'end' && (
        <Sheet title="End the session for everyone?" onClose={() => setSheet(null)}>
          <p className="t-lead">Location sharing and check-ins stop for the whole group. Open alerts must be acknowledged first.</p>
          {errorBox}
          <button
            type="button"
            className="btn pbtn on-accent"
            onClick={() => {
              if (run((d, t) => endSession(d, viewer.id, t))) {
                if (session.serverId) endSessionOnServer(session.serverId);
                setSheet(null);
              }
            }}
          >
            End session
          </button>
          <button type="button" className="btn pbtn fill" onClick={() => setSheet(null)}>
            Cancel
          </button>
        </Sheet>
      )}

    </div>
  );
}

/**
 * What had happened by a moment on the session's time bar (or so far, when
 * live), in sentences, as this person may see it: joins, alerts and their
 * escalation, and movements where a record of positions exists
 * (src/server/data/story.ts). Live positions are never stored, so for most
 * people there are no movements, and the sheet says so.
 */
function MomentSheet({ at, live, onClose }: { at: number; live: boolean; onClose(): void }) {
  const { state } = useApp();
  const session = state.session!;
  const [story, setStory] = useState<ServerStory | null | 'loading'>(session.serverId ? 'loading' : null);
  useEffect(() => {
    if (!session.serverId) return;
    let alive = true;
    fetchStory(session.serverId).then((s) => alive && setStory(s));
    return () => {
      alive = false;
    };
  }, [session.serverId]);

  // Without the server, this device's own record: the session, joins and alerts.
  const local = (): { t: number; text: string }[] => {
    const events: { t: number; text: string }[] = [{ t: session.createdAt, text: 'The session started.' }];
    for (const p of Object.values(state.participants)) {
      if (p.id !== session.hostId && p.consent.joinedAt) events.push({ t: p.consent.joinedAt, text: `${p.displayName} joined.` });
      if (p.leftAt) events.push({ t: p.leftAt, text: `${p.displayName} left.` });
    }
    for (const i of state.incidents) {
      const who = state.participants[i.participantId]?.displayName ?? 'Someone';
      events.push({ t: i.openedAt, text: `An alert opened about ${who}.` });
      if (i.acknowledged) events.push({ t: i.acknowledged.at, text: `${i.acknowledged.name} acknowledged the alert about ${who}.` });
      if (i.resolution) events.push({ t: i.resolution.at, text: `The alert about ${who} was resolved.` });
    }
    return events;
  };
  const events =
    story === 'loading' ? [] : story ? story.items.map((i) => ({ t: Date.parse(i.at), text: i.text })) : local();
  const shown = events.filter((e) => e.t <= at).sort((a, b) => b.t - a.t);
  const untold = story && story !== 'loading' ? story.noMovementRecord : [];

  return (
    <Sheet title={live ? 'What happened so far' : `What happened by ${fmtTime(at).slice(0, 5)}`} className="sheet-capped" onClose={onClose}>
      <div className="sheet-scroll">
        {story === 'loading' ? (
          <p className="t-sub">Loading…</p>
        ) : (
          <ol className="moment-list">
            {shown.map((e, i) => (
              <li key={`${e.t}-${i}`} className="moment-row">
                <span className="t-sub num moment-time">{fmtTime(e.t).slice(0, 5)}</span>
                <span className="t-body">{e.text}</span>
              </li>
            ))}
          </ol>
        )}
        {untold.length > 0 && (
          <p className="t-cap" style={{ marginTop: 12 }}>
            No movements for {untold.join(', ')}: live positions are shown on the map but never stored.
          </p>
        )}
      </div>
      <button type="button" className="btn pbtn fill" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}
