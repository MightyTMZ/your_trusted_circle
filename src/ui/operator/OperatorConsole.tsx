import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallView, CapabilitiesResponse, FactView, ReplyView, TurnResponse } from '../../server/voice/protocol';
import { Icon } from '../components/Icon';
import { SimulatedTag } from '../components/SimulatedTag';
import { callApi } from './api';
import { PushToTalk } from './recorder';

/**
 * Operator console: the person at the keyboard plays the simulated emergency
 * operator. The agent calls in with the incident breakdown and answers
 * follow-up questions, spoken with ElevenLabs and checked against the record.
 */

type Phase = 'idle' | 'starting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'ended';

/** Silence after the agent finishes before it asks if the operator is still there. */
const SILENCE_MS = 25_000;
/** Shorter holds are treated as accidental taps. */
const MIN_HOLD_MS = 350;
/** Empty WAV played inside the click that starts the call, so later playback is allowed (Safari). */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const PATH_LABEL: Record<ReplyView['path'], string> = {
  model: 'Model answer · guard and judge passed',
  model_repaired: 'Model answer · passed on a second draft',
  fallback: 'Read from the record verbatim',
  scripted: 'Scripted from the record',
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

export function OperatorConsole() {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [call, setCall] = useState<CallView | null>(null);
  const [replies, setReplies] = useState<Record<number, ReplyView>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [voiceOn, setVoiceOn] = useState(true);
  const [micReady, setMicReady] = useState(false);
  const [cited, setCited] = useState<string[]>([]);
  const [busySince, setBusySince] = useState(0);
  const [, tick] = useState(0);

  const audio = useRef<HTMLAudioElement | null>(null);
  const speaking = useRef<number | null>(null);
  const mic = useRef<PushToTalk | null>(null);
  const silenceTimer = useRef<number | undefined>(undefined);
  const callRef = useRef<CallView | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const voiceRef = useRef(true);
  const textRef = useRef('');
  const transcriptEnd = useRef<HTMLLIElement | null>(null);
  callRef.current = call;
  phaseRef.current = phase;
  voiceRef.current = voiceOn;
  textRef.current = text;

  useEffect(() => {
    callApi.capabilities().then(setCaps, (e: Error) => setError(e.message));
    audio.current = new Audio();
    return () => {
      audio.current?.pause();
      mic.current?.close();
      window.clearTimeout(silenceTimer.current);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'thinking' && phase !== 'starting') return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // Braces matter: Chrome's scrollIntoView now returns a Promise, which React would treat as a cleanup function.
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
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
      // Not while the operator is mid-sentence in the text box.
      if (!current || phaseRef.current !== 'ready' || textRef.current.trim()) return;
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
        setError('The voice could not play this turn; the text is shown instead.');
        settle(callRef.current);
      };
      el.play().catch(() => {
        speaking.current = null;
        setError('The browser blocked audio playback. Click anywhere, then use Replay.');
        settle(callRef.current);
      });
    },
    [settle],
  );

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

  const startCall = async () => {
    const el = audio.current;
    if (el) {
      el.src = SILENT_WAV;
      el.play().catch(() => {});
    }
    setError(null);
    setReplies({});
    setCited([]);
    setPhase('starting');
    setBusySince(performance.now());
    const known = caps ?? (await callApi.capabilities().catch(() => null));
    setCaps(known);
    if (known?.speech_to_text && PushToTalk.supported) {
      try {
        mic.current = new PushToTalk();
        await mic.current.open();
        setMicReady(true);
      } catch {
        setMicReady(false);
        setError('Microphone unavailable, so type your questions instead.');
      }
    }
    try {
      const res = await callApi.start();
      setCall(res.call);
      play(res.reply, res.call);
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  };

  const sendText = async (line: string) => {
    const current = callRef.current;
    if (!current || !line.trim() || phaseRef.current === 'ended') return;
    clearSilence();
    await bargeIn();
    setText('');
    setError(null);
    setPhase('thinking');
    setBusySince(performance.now());
    setCall({ ...current, transcript: [...current.transcript, pendingTurn(line)] });
    try {
      handleTurn(await callApi.say(current.call_id, line));
    } catch (e) {
      setError((e as Error).message);
      settle(callRef.current);
      callApi.state(current.call_id).then((r) => setCall(r.call), () => {});
    }
  };

  const talkStart = async () => {
    if (!mic.current || !micReady || !callRef.current || phaseRef.current === 'ended' || mic.current.recording) return;
    clearSilence();
    // Record at once; the interrupt is logged in the background, long before this turn is sent.
    void bargeIn();
    setError(null);
    mic.current.start();
    setPhase('listening');
  };

  const talkStop = async () => {
    const current = callRef.current;
    if (!mic.current?.recording || !current) return;
    const take = await mic.current.stop();
    if (!take || take.heldMs < MIN_HOLD_MS) {
      setError('Hold the button (or the space bar) while you speak.');
      settle(current);
      return;
    }
    setPhase('thinking');
    setBusySince(performance.now());
    try {
      handleTurn(await callApi.speak(current.call_id, take.audio));
    } catch (e) {
      setError((e as Error).message);
      settle(callRef.current);
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

  const toggleVoice = () => {
    if (voiceOn && speaking.current !== null) {
      audio.current?.pause();
      speaking.current = null;
      settle(callRef.current);
    }
    setVoiceOn(!voiceOn);
  };

  const replay = () => {
    const last = call?.transcript.filter((t) => t.speaker === 'voice_agent').at(-1);
    const reply = last && replies[last.turn_index];
    if (reply && call) {
      clearSilence();
      play(reply, call);
    }
  };

  // Space bar is push-to-talk, except while typing.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e) || e.repeat) return;
      e.preventDefault();
      void talkStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      void talkStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  const live = !!call && phase !== 'ended';
  const busySeconds = Math.max(0, Math.floor((performance.now() - busySince) / 1000));
  const status =
    phase === 'starting'
      ? 'Connecting the simulated call…'
      : phase === 'listening'
        ? 'Listening. Release to send.'
        : phase === 'thinking'
          ? `Agent is checking the record… ${busySeconds}s`
          : phase === 'speaking'
            ? 'Agent speaking. Hold to interrupt.'
            : phase === 'ended'
              ? `Call ended${call?.ended_reason ? ` (${call.ended_reason.replace('_', ' ')})` : ''}.`
              : phase === 'ready'
                ? micReady
                  ? 'Your turn. Hold to talk, or type.'
                  : 'Your turn. Type a question.'
                : '';

  const dot = !live ? 'hollow' : phase === 'speaking' || phase === 'listening' ? 'live' : '';

  // Same shell as the app (.app-main is the container the two-column layout responds to).
  return (
    <div className="app">
      <main className="app-main">
        <div className="screen op">
          <header className="op-head">
            <div className="stack" style={{ gap: 6 }}>
              <span className="header" style={{ gap: 10 }}>
                <span className="lbl" style={{ padding: 0 }}>
                  Operator console
                </span>
                <SimulatedTag />
              </span>
              <h1 className="t-title">Simulated emergency operator</h1>
              <p className="t-lead">You play the operator. The YTC voice agent calls about a synthetic incident and answers only from its record.</p>
            </div>
            <a className="btn chip fill" href="#">
              Back to the app
            </a>
          </header>

          <section className="surface card stack" style={{ gap: 6 }}>
            <span className="t-name">Simulated call</span>
            <p className="t-sub">No real emergency services or phone line are involved (simulated emergency services only). The incident, person and venue are synthetic.</p>
            <span className="t-cap num">
              Reasoning: {caps?.reasoning ?? 'off, facts read verbatim'} · Voice: {caps?.text_to_speech ?? 'off'} · Speech in: {caps?.speech_to_text ?? 'off, type instead'}
            </span>
          </section>

          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}

          {!call ? (
            <section className="surface card stack op-start" style={{ gap: 16 }}>
              <p className="t-body">
                When you answer, the agent opens with a breakdown of the incident read from its record. Then ask follow-ups out loud (hold the
                button or the space bar) or by typing.
              </p>
              <button type="button" className="btn pbtn on-accent" disabled={phase === 'starting'} onClick={startCall}>
                {phase === 'starting' ? 'Connecting…' : 'Answer the simulated call'}
              </button>
            </section>
          ) : (
            <div className="cols">
              <div className="col">
                <section className="surface card" role="status">
                  <span className="header" style={{ gap: 10 }}>
                    <span className={`dot ${dot}`} aria-hidden="true" />
                    <span className="t-name grow">{status}</span>
                    <span className="t-cap num">{call.call_id}</span>
                  </span>
                </section>

                <ol className="transcript op-transcript" aria-label="Transcript">
                  {call.transcript.map((t) => (
                    <Turn key={`${t.turn_index}-${t.speaker}`} turn={t} reply={replies[t.turn_index]} facts={call.facts} />
                  ))}
                  {phase === 'thinking' && (
                    <li className="bubble fill agent">
                      <span className="t-body">Checking the record…</span>
                    </li>
                  )}
                  <li ref={transcriptEnd} aria-hidden="true" />
                </ol>

                <div className="stack" style={{ gap: 12 }}>
                  {micReady && (
                    <button
                      type="button"
                      className={`btn pbtn op-talk ${phase === 'listening' ? 'on-accent' : 'fill'}`}
                      disabled={!live}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        void talkStart();
                      }}
                      onPointerUp={() => void talkStop()}
                      onPointerCancel={() => void talkStop()}
                    >
                      <Icon name="mic" />
                      {phase === 'listening' ? 'Listening… release to send' : 'Hold to talk (or hold space)'}
                    </button>
                  )}
                  <form
                    className="fill inputbar"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendText(text);
                    }}
                  >
                    <label htmlFor="op-question" className="sr-only">
                      Operator question
                    </label>
                    <input
                      id="op-question"
                      className="field field-bare"
                      placeholder="Type an operator question"
                      autoComplete="off"
                      value={text}
                      disabled={!live}
                      maxLength={1000}
                      onChange={(e) => {
                        setText(e.target.value);
                        clearSilence();
                      }}
                    />
                    <button type="submit" className="btn ibtn on-accent" aria-label="Send" disabled={!live || !text.trim()}>
                      <Icon name="send" />
                    </button>
                  </form>
                  <div className="hscroll">
                    <button type="button" className="btn chip fill" onClick={toggleVoice} disabled={!caps?.text_to_speech}>
                      {voiceOn ? 'Mute voice' : 'Unmute voice'}
                    </button>
                    <button type="button" className="btn chip fill" onClick={replay} disabled={!live || phase === 'thinking' || !voiceOn}>
                      Replay last answer
                    </button>
                    {live ? (
                      <button type="button" className="btn chip fill" onClick={endCall}>
                        End call
                      </button>
                    ) : (
                      <button type="button" className="btn chip fill" onClick={startCall}>
                        New call
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="col">
                <section className="surface card stack" style={{ gap: 12 }}>
                  <span className="header">
                    <h2 className="t-card grow">Incident record</h2>
                    <span className="t-cap num">{call.facts.length} facts</span>
                  </span>
                  <p className="t-sub">Everything the agent may say. Highlighted: what its last answer cited.</p>
                  <FactList facts={call.facts} cited={cited} />
                </section>
                <section className="surface card stack" style={{ gap: 12 }}>
                  <span className="header">
                    <h2 className="t-card grow">Call log</h2>
                    <span className="t-cap num">
                      {call.timeline_events} events · {call.rejected_drafts} drafts rejected
                    </span>
                  </span>
                  <ol className="op-log">
                    {call.log.map((l) => (
                      <li key={l.event_id} className={`t-cap ${l.type === 'voice.draft_rejected' || l.type === 'voice.agent_error' ? 'warn' : ''}`}>
                        <span className="num">{l.at.slice(11, 19)}</span> {l.summary}
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function pendingTurn(text: string): CallView['transcript'][number] {
  return { turn_index: -1, speaker: 'mock_operator', text, at: new Date().toISOString() };
}

function Turn({ turn, reply, facts }: { turn: CallView['transcript'][number]; reply?: ReplyView; facts: FactView[] }) {
  const agent = turn.speaker === 'voice_agent';
  const sources = reply?.facts.length ? reply.facts : facts.filter((f) => reply?.fact_ids.includes(f.id));
  return (
    <li className={`bubble ${agent ? 'fill agent' : 'fill-2 operator'}`}>
      <span className="t-cap num">
        {agent ? 'YTC automated assistant' : 'You (operator)'} · {turn.at.slice(11, 16)} UTC
      </span>
      <span className="t-body">{turn.text}</span>
      {turn.interrupted_after_ms !== undefined && (
        <span className="t-cap num">You interrupted after {(turn.interrupted_after_ms / 1000).toFixed(1)} s.</span>
      )}
      {agent && reply && (
        <details className="op-sources">
          <summary className="t-cap num">
            {PATH_LABEL[reply.path]}
            {reply.path !== 'scripted' ? ` · ${(reply.latency_ms / 1000).toFixed(1)} s` : ''}
            {reply.rejected.length ? ` · ${reply.rejected.length} draft${reply.rejected.length > 1 ? 's' : ''} rejected` : ''}
            {sources.length ? ` · cites ${sources.map((f) => f.id).join(', ')}` : ''}
          </summary>
          {sources.map((f) => (
            <p key={f.id} className="t-cap">
              <span className="num">{f.id}</span> {f.text} <span className="num">[{f.source_event_ids.join(', ')}]</span>
            </p>
          ))}
          {reply.rejected.map((r) => (
            <p key={r.attempt} className="t-cap">
              Draft {r.attempt} rejected at the {r.stage} check, never spoken: {r.reasons.join('; ')}
            </p>
          ))}
          {reply.model_id && <p className="t-cap">Model: {reply.model_id}</p>}
        </details>
      )}
    </li>
  );
}

function FactList({ facts, cited }: { facts: FactView[]; cited: string[] }) {
  const topics = [...new Set(facts.map((f) => f.topic))];
  return (
    <div className="op-facts">
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
