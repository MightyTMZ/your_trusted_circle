import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallView, CapabilitiesResponse, FactView, IncomingCall, ReplyView, StartCallResponse, TurnResponse } from '../../server/voice/protocol';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { callApi } from './api';
import { PushToTalk } from './recorder';

/**
 * Operator console: the person at this screen plays the simulated emergency
 * operator. One fixed page that never scrolls: standby, then an incoming call
 * that rings like a phone call, then the call itself as a chat. The agent's
 * real steps show live under the conversation; the incident record opens in
 * a sheet.
 */

type Phase = 'idle' | 'starting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'ended';
type Activity = NonNullable<CallView['activity']>;

/**
 * Silence after the agent finishes before it asks if the operator is still there
 * (and, the second time, ends the call). Long enough to talk to a room between questions.
 */
const SILENCE_MS = 60_000;
/** Shorter holds are treated as accidental taps. */
const MIN_HOLD_MS = 350;
/** How often the console checks for a call placed by escalation. */
const RING_POLL_MS = 1500;
/** How often it reads the agent's current step while an answer is being prepared. */
const ACTIVITY_POLL_MS = 400;
/** Empty WAV played inside the click that starts the call, so later playback is allowed (Safari). */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const CALLER = 'YTC safety assistant';

/** The agent's steps for one answer, in order, as the operator reads them. */
const STEPS: { stage: Activity['stage']; label: string }[] = [
  { stage: 'reading_record', label: 'Reading the record' },
  { stage: 'finding_facts', label: 'Finding the facts' },
  { stage: 'drafting', label: 'Drafting' },
  { stage: 'checking', label: 'Checking each sentence' },
  { stage: 'verifying', label: 'Verifying' },
];

const PATH_LABEL: Record<ReplyView['path'], string> = {
  model: 'Checked against the record',
  model_repaired: 'Checked against the record, second draft',
  fallback: 'Read from the record word for word',
  scripted: 'Read from the record',
};

const TOPIC_LABEL: Record<string, string> = {
  scope: 'What the agent is',
  identity: 'Identity',
  notes: 'Their note',
  description: 'Description',
  contact_details: 'Contact details',
  location: 'Last-known location',
  location_history: 'Earlier locations',
  incident: 'Alert',
  condition: 'Condition',
  checkin: 'Check-ins',
  motion: 'Phone movement',
  motion_history: 'Movement earlier tonight',
  device: 'Phone connection',
  alerts: 'Who was alerted',
  escalation: 'Escalation',
};

/** The call id in #operator?call=<id>, from the app's "Answer as the operator". */
function wantedCall(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('call');
}

export function OperatorConsole() {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [incoming, setIncoming] = useState<IncomingCall[]>([]);
  const [call, setCall] = useState<CallView | null>(null);
  const [replies, setReplies] = useState<Record<number, ReplyView>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [micReady, setMicReady] = useState(false);
  const [cited, setCited] = useState<string[]>([]);
  const [record, setRecord] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [, tick] = useState(0);

  const audio = useRef<HTMLAudioElement | null>(null);
  const speaking = useRef<number | null>(null);
  const mic = useRef<PushToTalk | null>(null);
  const silenceTimer = useRef<number | undefined>(undefined);
  const callRef = useRef<CallView | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const voiceRef = useRef(true);
  const recordRef = useRef(false);
  const spaceHeld = useRef(false);
  const stopping = useRef(false);
  const chatEnd = useRef<HTMLLIElement | null>(null);
  callRef.current = call;
  phaseRef.current = phase;
  voiceRef.current = voiceOn;
  recordRef.current = record;

  useEffect(() => {
    callApi.capabilities().then(setCaps, (e: Error) => setError(e.message));
    audio.current = new Audio();
    return () => {
      audio.current?.pause();
      mic.current?.close();
      window.clearTimeout(silenceTimer.current);
    };
  }, []);

  // Calls placed by escalation ring here until someone answers.
  useEffect(() => {
    if (call) return;
    let alive = true;
    const poll = () =>
      callApi.incoming().then(
        (r) => {
          if (!alive) return;
          setIncoming(r.calls);
          setError(null);
        },
        (e) => alive && setError((e as Error).message),
      );
    poll();
    const id = window.setInterval(poll, RING_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [call]);

  // Opened for a call someone already answered: show it so the operator can carry on.
  useEffect(() => {
    const id = wantedCall();
    if (!id) return;
    callApi.state(id).then(
      (r) => {
        if (r.call.status !== 'active') return;
        setCall(r.call);
        setConnectedAt(Date.parse(r.call.transcript[0]?.at ?? new Date().toISOString()));
        setPhase('ready');
      },
      (e) => setError((e as Error).message),
    );
  }, []);

  // While the agent prepares an answer, follow its real steps on the server.
  useEffect(() => {
    if (phase !== 'thinking' || !call) {
      setActivity(null);
      return;
    }
    let alive = true;
    const id = window.setInterval(() => {
      callApi.state(call.call_id).then(
        (r) => alive && phaseRef.current === 'thinking' && setActivity(r.call.activity),
        (e) => alive && setError((e as Error).message),
      );
    }, ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [phase, call?.call_id]);

  // The call timer and the ringing time.
  useEffect(() => {
    if (!connectedAt && incoming.length === 0) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [connectedAt, incoming.length]);

  // Braces matter: Chrome's scrollIntoView now returns a Promise, which React would treat as a cleanup function.
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [call?.transcript.length, phase]);

  const clearSilence = () => window.clearTimeout(silenceTimer.current);

  const settle = useCallback((next: CallView | null) => {
    if (next?.status === 'ended') {
      setPhase('ended');
      mic.current?.close();
      setMicReady(false);
      return;
    }
    setPhase('ready');
    clearSilence();
    silenceTimer.current = window.setTimeout(async () => {
      const current = callRef.current;
      // not while the operator is reading the record
      if (!current || phaseRef.current !== 'ready' || recordRef.current) return;
      try {
        const res = await callApi.silence(current.call_id, SILENCE_MS);
        setCall(res.call);
        if (res.reply) play(res.reply, res.call);
      } catch (e) {
        setError((e as Error).message);
      }
    }, SILENCE_MS);
    // play is declared below; it reads only refs, so the first one stays correct.
  }, []);

  const play = useCallback(
    (reply: ReplyView, after: CallView) => {
      setReplies((r) => ({ ...r, [reply.turn_index]: reply }));
      setCited(reply.fact_ids);
      const el = audio.current;
      if (!voiceRef.current || !reply.audio_url || !el) {
        settle(after);
        return;
      }
      speaking.current = reply.turn_index;
      setPhase('speaking');
      el.src = reply.audio_url;
      el.onended = () => {
        speaking.current = null;
        settle(callRef.current);
      };
      el.onerror = () => {
        speaking.current = null;
        setError("The voice couldn't play this turn. The text is shown instead.");
        settle(callRef.current);
      };
      el.play().catch(() => {
        speaking.current = null;
        setError('The browser blocked audio. Tap anywhere, then try again.');
        settle(callRef.current);
      });
    },
    [settle],
  );

  const startPractice = async () => {
    setError(null);
    setReplies({});
    setCited([]);
    setPhase('starting');
    try {
      const res = await callApi.start();
      setCall(res.call);
      setConnectedAt(Date.now());
      play(res.reply, res.call);
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  };

  /** Stops the agent mid-sentence (at once) and logs how much the operator heard. */
  const bargeIn = async () => {
    const el = audio.current;
    const turn = speaking.current;
    const current = callRef.current;
    if (!el || turn === null || !current) return;
    const heardMs = Math.round(el.currentTime * 1000);
    el.pause();
    el.onended = null;
    el.onerror = null;
    speaking.current = null;
    try {
      const res = await callApi.interrupt(current.call_id, turn, heardMs);
      setCall(res.call);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTurn = (res: TurnResponse) => {
    setCall(res.call);
    // null: a newer operator turn superseded this one, and its answer will play instead.
    if (res.reply) play(res.reply, res.call);
  };

  /** Unlocks audio and the microphone inside the tap, then answers the call. */
  const answer = async (id: string) => {
    const el = audio.current;
    if (el) {
      el.src = SILENT_WAV;
      el.play().catch(() => {});
    }
    setError(null);
    setReplies({});
    setCited([]);
    setPhase('starting');
    const known = caps ?? (await callApi.capabilities().catch(() => null));
    setCaps(known);
    if (known?.speech_to_text && PushToTalk.supported) {
      try {
        mic.current = new PushToTalk();
        await mic.current.open();
        setMicReady(true);
      } catch {
        setMicReady(false);
        setError('The microphone is unavailable. Voice input is required for this console.');
      }
    }
    try {
      const res: StartCallResponse = await callApi.answer(id);
      setCall(res.call);
      setConnectedAt(Date.now());
      play(res.reply, res.call);
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  };

  const talkStart = async () => {
    if (stopping.current || !mic.current || !micReady || !callRef.current || phaseRef.current === 'ended' || mic.current.recording) return;
    clearSilence();
    // Record at once; the interrupt is logged in the background, long before this turn is sent.
    void bargeIn();
    setError(null);
    mic.current.start();
    setPhase('listening');
  };

  const talkStop = async () => {
    if (stopping.current) return;
    const current = callRef.current;
    if (!mic.current?.recording || !current) return;
    stopping.current = true;
    try {
      const take = await mic.current.stop();
      if (!take || take.heldMs < MIN_HOLD_MS) {
        setError('Keep holding while you speak, then let go.');
        settle(current);
        return;
      }
      setPhase('thinking');
      try {
        handleTurn(await callApi.speak(current.call_id, take.audio));
      } catch (e) {
        setError((e as Error).message);
        settle(callRef.current);
      }
    } finally {
      stopping.current = false;
    }
  };

  const endCall = async () => {
    const current = callRef.current;
    if (!current) return;
    clearSilence();
    audio.current?.pause();
    speaking.current = null;
    try {
      const res = await callApi.end(current.call_id);
      setCall(res.call);
    } catch (e) {
      setError((e as Error).message);
    }
    settle({ ...current, status: 'ended' });
  };

  const backToStandby = () => {
    setCall(null);
    setPhase('idle');
    setConnectedAt(null);
    setRecord(false);
    history.replaceState(null, '', '#operator');
  };

  const toggleVoice = () => {
    if (voiceOn && speaking.current !== null) {
      audio.current?.pause();
      speaking.current = null;
      settle(callRef.current);
    }
    setVoiceOn(!voiceOn);
  };

  // space bar is push-to-talk.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || spaceHeld.current || recordRef.current) return;
      e.preventDefault();
      spaceHeld.current = true;
      void talkStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHeld.current) return;
      e.preventDefault();
      spaceHeld.current = false;
      void talkStop();
    };
    const release = () => {
      if (!spaceHeld.current) return;
      spaceHeld.current = false;
      void talkStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  });

  // The call the app asked for, else the one ringing longest.
  const want = wantedCall();
  const ringing = incoming.find((c) => c.call_id === want) ?? incoming[0] ?? null;

  // ── Standby and ringing ────────────────────────────────────────────────
  if (!call) {
    if (ringing) {
      return (
        <div className="opx opx-ring" role="dialog" aria-modal="true" aria-labelledby="ring-name">
          <div className="opx-ring-top">
            <span className="t-sub num">Ringing {fmtDuration(Date.now() - Date.parse(ringing.ringing_since))}</span>
          </div>
          <div className="opx-caller">
            <span className="opx-caller-av" aria-hidden="true">
              YTC
            </span>
            <h1 className="t-title" id="ring-name">
              {CALLER}
            </h1>
            <p className="t-lead">About {ringing.about}</p>
            <p className="t-cap opx-why">Nobody acknowledged the alert, so it escalated to simulated emergency services.</p>
          </div>
          {error && <ErrorLine text={error} />}
          <div className="opx-ring-actions">
            <button type="button" className="btn opx-accept" disabled={phase === 'starting'} onClick={() => answer(ringing.call_id)} aria-label="Accept call">
              <Icon name="phone" size={30} />
            </button>
            <span className="t-sub">{phase === 'starting' ? 'Connecting…' : 'Accept'}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="opx opx-standby">
        <div className="opx-bar">
          <span className="t-name">Operator line</span>
        </div>
        <div className="opx-caller">
          <span className="opx-standby-ic" aria-hidden="true">
            <Icon name="phone" size={28} />
          </span>
          <h1 className="t-title">Standing by</h1>
          <p className="t-sub">Calls ring here. No real phone line or emergency service is connected.</p>
        </div>
        {error && <ErrorLine text={error} />}
        <div className="opx-tools">
          <button type="button" className="btn pbtn on-accent" disabled={phase === 'starting'} onClick={() => void startPractice()}>
            Practice a call
          </button>
          <button type="button" className="btn pbtn fill" onClick={() => (window.location.hash = '')}>
            Back to app
          </button>
        </div>
      </div>
    );
  }

  // ── On the call ────────────────────────────────────────────────────────
  const live = phase !== 'ended';
  const elapsed = connectedAt ? Date.now() - connectedAt : 0;
  const status = !live
    ? `Call ended${call.ended_reason ? `, ${call.ended_reason.replace('_', ' ')}` : ''}`
    : phase === 'starting'
      ? 'Connecting…'
      : fmtDuration(elapsed);
  const voiceIn = !!caps?.speech_to_text && PushToTalk.supported;

  return (
    <div className="opx">
      <header className="opx-bar">
        <span className="opx-caller-mini" aria-hidden="true">
          YTC
        </span>
        <span className="stack grow" style={{ minWidth: 0 }}>
          <span className="t-name">{CALLER}</span>
          <span className="t-cap num" role="status">
            {status}
          </span>
        </span>
        <button type="button" className="btn chip fill" onClick={() => setRecord(true)}>
          <Icon name="file" size={16} />
          Record
        </button>
      </header>

      <ol className="opx-chat" aria-label="Conversation">
        {call.transcript.map((t) => (
          <Turn key={`${t.turn_index}-${t.speaker}-${t.at}`} turn={t} reply={replies[t.turn_index]} facts={call.facts} />
        ))}
        <li ref={chatEnd} aria-hidden="true" />
      </ol>

      <div className="opx-dock">
        <ActivityStrip phase={phase} activity={activity} voiceIn={voiceIn && micReady} />
        {error && <ErrorLine text={error} />}
        {live ? (
          <div className="opx-compose">
            <button
              type="button"
              className={`btn opx-mic ${phase === 'listening' ? 'on-accent is-live' : 'fill'}`}
              aria-label={voiceIn ? 'Hold to talk' : 'Voice input is unavailable'}
              disabled={!voiceIn || !micReady}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                void talkStart();
              }}
              onPointerUp={() => void talkStop()}
              onPointerCancel={() => void talkStop()}
              onLostPointerCapture={() => void talkStop()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <Icon name={voiceIn ? 'mic' : 'micOff'} size={26} />
            </button>
          </div>
        ) : (
          <button type="button" className="btn pbtn fill" onClick={backToStandby}>
            Done
          </button>
        )}
        {live && (
          <div className="opx-tools">
            {caps?.text_to_speech && (
              <button type="button" className="btn chip fill" onClick={toggleVoice}>
                {voiceOn ? 'Mute the agent' : 'Unmute the agent'}
              </button>
            )}
            <button type="button" className="btn chip fill" onClick={endCall}>
              <Icon name="x" size={16} />
              End call
            </button>
          </div>
        )}
      </div>

      {record && (
        <Sheet title="Incident record" centered className="sheet-capped" onClose={() => setRecord(false)}>
          <p className="t-sub">Everything the agent may say, and nothing else. Highlighted: what its last answer cited.</p>
          <div className="opx-record sheet-scroll">
            <FactList facts={call.facts} cited={cited} />
            <div className="stack" style={{ gap: 8 }}>
              <span className="lbl" style={{ padding: 0 }}>
                Call log · {call.timeline_events} events in the record · {call.rejected_drafts} drafts rejected
              </span>
              <ol className="opx-log">
                {call.log.map((l) => (
                  <li key={l.event_id} className={`t-cap ${l.type === 'voice.draft_rejected' || l.type === 'voice.agent_error' ? 'warn' : ''}`}>
                    <span className="num">{l.at.slice(11, 19)}</span> {l.summary}
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <button type="button" className="btn pbtn fill" onClick={() => setRecord(false)}>
            Close
          </button>
        </Sheet>
      )}
    </div>
  );
}

/** What is happening right now: the agent's real steps while it prepares an answer, or whose turn it is. */
function ActivityStrip({ phase, activity, voiceIn }: { phase: Phase; activity: Activity | null; voiceIn: boolean }) {
  if (phase === 'thinking') {
    const current = activity?.stage ?? 'reading_record';
    const at = STEPS.findIndex((s) => s.stage === current);
    return (
      <div className="opx-activity" role="status" aria-live="polite">
        {current === 'fallback' ? (
          <span className="opx-step is-on">No draft passed the checks. Reading the facts word for word.</span>
        ) : (
          STEPS.map((s, i) => (
            <span key={s.stage} className={`opx-step ${i === at ? 'is-on' : i < at ? 'is-done' : ''}`}>
              {i === at && <span className="opx-pulse" aria-hidden="true" />}
              {s.label}
              {s.stage === current && activity && activity.attempt > 1 ? ` (try ${activity.attempt})` : ''}
            </span>
          ))
        )}
      </div>
    );
  }
  const line =
    phase === 'starting'
      ? 'Connecting the simulated call…'
      : phase === 'listening'
        ? 'Listening. Let go to send.'
        : phase === 'speaking'
          ? 'The agent is speaking. Talk to interrupt.'
          : phase === 'ended'
            ? ''
            : null;
  if (line === '') return null;
  return (
    <div className="opx-activity" role="status" aria-live="polite">
      {line ??
        (voiceIn ? (
        <>
          <span className="opx-hint-touch">Your turn. Hold the microphone to talk.</span>
          <span className="opx-hint-key">
            Your turn. Hold <kbd>Space</kbd> to talk.
          </span>
        </>
      ) : (
          'Voice input is unavailable on this server.'
        ))}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="error" role="alert">
      <Icon name="alert" />
      {text}
    </p>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Turn({ turn, reply, facts }: { turn: CallView['transcript'][number]; reply?: ReplyView; facts: FactView[] }) {
  const agent = turn.speaker === 'voice_agent';
  const sources = reply?.facts.length ? reply.facts : facts.filter((f) => reply?.fact_ids.includes(f.id));
  return (
    <li className={`bubble ${agent ? 'fill agent' : 'fill-2 operator'}`}>
      <span className="t-body">{turn.text}</span>
      {turn.interrupted_after_ms !== undefined && <span className="t-cap num">Interrupted after {(turn.interrupted_after_ms / 1000).toFixed(1)} s</span>}
      {agent && reply && (
        <details className="opx-sources">
          <summary className="t-cap num">
            {PATH_LABEL[reply.path]}
            {reply.path !== 'scripted' ? ` · ${(reply.latency_ms / 1000).toFixed(1)} s` : ''}
            {reply.rejected.length ? ` · ${reply.rejected.length} draft${reply.rejected.length > 1 ? 's' : ''} rejected` : ''}
            {sources.length ? ` · ${sources.map((f) => f.id).join(', ')}` : ''}
          </summary>
          {sources.map((f) => (
            <p key={f.id} className="t-cap">
              <span className="num">{f.id}</span> {f.text}
            </p>
          ))}
          {reply.rejected.map((r) => (
            <p key={r.attempt} className="t-cap">
              Draft {r.attempt} failed the {r.stage} check and was never spoken: {r.reasons.join('; ')}
            </p>
          ))}
        </details>
      )}
    </li>
  );
}

function FactList({ facts, cited }: { facts: FactView[]; cited: string[] }) {
  const topics = [...new Set(facts.map((f) => f.topic))];
  return (
    <div className="opx-facts">
      {topics.map((topic) => (
        <div key={topic} className="stack" style={{ gap: 6 }}>
          <span className="lbl" style={{ padding: 0 }}>
            {TOPIC_LABEL[topic] ?? topic}
          </span>
          {facts
            .filter((f) => f.topic === topic)
            .map((f) => (
              <p key={f.id} className={`t-sub op-fact ${cited.includes(f.id) ? 'cited' : ''}`}>
                <span className="num">{f.id}</span> {f.text}
              </p>
            ))}
        </div>
      ))}
    </div>
  );
}
