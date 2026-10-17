import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallView, FactView, HealthResponse, ReplyView, TurnResponse } from '../../server/protocol';
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
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
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  callRef.current = call;
  phaseRef.current = phase;
  voiceRef.current = voiceOn;
  textRef.current = text;

  useEffect(() => {
    callApi.health().then(setHealth, (e: Error) => setError(e.message));
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
    const caps = health ?? (await callApi.health().catch(() => null));
    setHealth(caps);
    if (caps?.speech_to_text && PushToTalk.supported) {
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

  return (
    <div className="op">
      <header className="op-head">
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <span className="eyebrow">Operator console</span>
            <SimulatedTag />
          </div>
          <h1 className="title">Simulated emergency operator</h1>
          <p className="small">
            You play the operator. The YTC voice agent calls in about a synthetic incident and answers from its record only.
          </p>
        </div>
        <div className="op-caps tiny">
          <span>Reasoning: {health?.reasoning ?? 'off (facts read verbatim)'}</span>
          <span>Voice: {health?.text_to_speech ?? 'off (text only)'}</span>
          <span>Speech in: {health?.speech_to_text ?? 'off (type instead)'}</span>
          <a className="link" href="#">Back to the app</a>
        </div>
      </header>

      <div className="banner-sim">
        <strong>Simulated.</strong> No real emergency services or phone line are involved (simulated emergency services only). The
        incident, person and venue are synthetic.
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!call ? (
        <section className="panel op-start">
          <p>
            When you start, the agent opens with a full breakdown of the incident, read from the record. Then ask follow-up questions
            out loud (hold the button or the space bar) or by typing.
          </p>
          <button className="btn btn-primary btn-large" disabled={phase === 'starting'} onClick={startCall}>
            {phase === 'starting' ? 'Connecting…' : 'Answer the simulated call'}
          </button>
        </section>
      ) : (
        <div className="op-grid">
          <section className="op-call">
            <div className="op-transcript" aria-live="polite">
              {call.transcript.map((t) => (
                <Turn key={`${t.turn_index}-${t.speaker}`} turn={t} reply={replies[t.turn_index]} facts={call.facts} />
              ))}
              {phase === 'thinking' && <div className="utt agent op-pending">Checking the record…</div>}
              <div ref={transcriptEnd} />
            </div>

            <div className="op-controls">
              <div className="spread">
                <span className={`op-status ${phase}`}>
                  <span className="dot" /> {status}
                </span>
                <span className="tiny mono">{call.call_id}</span>
              </div>
              {micReady && (
                <button
                  className={`btn btn-large btn-block op-talk ${phase === 'listening' ? 'on' : ''}`}
                  disabled={!live}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    void talkStart();
                  }}
                  onPointerUp={() => void talkStop()}
                  onPointerCancel={() => void talkStop()}
                >
                  {phase === 'listening' ? 'Listening… release to send' : 'Hold to talk (or hold space)'}
                </button>
              )}
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendText(text);
                }}
              >
                <input
                  className="input"
                  placeholder="Type an operator question"
                  value={text}
                  disabled={!live}
                  maxLength={1000}
                  onChange={(e) => {
                    setText(e.target.value);
                    clearSilence();
                  }}
                />
                <button className="btn btn-secondary" type="submit" disabled={!live || !text.trim()}>
                  Send
                </button>
              </form>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <button className="chip" onClick={toggleVoice} disabled={!health?.text_to_speech}>
                  {voiceOn ? 'Mute voice' : 'Unmute voice'}
                </button>
                <button className="chip" onClick={replay} disabled={!live || phase === 'thinking' || !voiceOn}>
                  Replay last answer
                </button>
                {live ? (
                  <button className="chip op-hangup" onClick={endCall}>
                    End call
                  </button>
                ) : (
                  <button className="chip" onClick={startCall}>
                    New call
                  </button>
                )}
              </div>
            </div>
          </section>

          <aside className="op-side">
            <section className="panel">
              <div className="spread">
                <h2 className="h2">Incident record</h2>
                <span className="tiny">{call.facts.length} facts</span>
              </div>
              <p className="tiny">Everything the agent may say. Highlighted: what its last answer cited.</p>
              <FactList facts={call.facts} cited={cited} />
            </section>
            <section className="panel">
              <div className="spread">
                <h2 className="h2">Call log</h2>
                <span className="tiny">
                  {call.timeline_events} timeline events · {call.rejected_drafts} drafts rejected
                </span>
              </div>
              <ol className="op-log">
                {call.log.map((l) => (
                  <li key={l.event_id} className={l.type === 'voice.draft_rejected' || l.type === 'voice.agent_error' ? 'warn' : ''}>
                    <span className="mono tiny">{l.at.slice(11, 19)}</span> <span className="tiny">{l.summary}</span>
                  </li>
                ))}
              </ol>
            </section>
          </aside>
        </div>
      )}
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
    <div className={`utt ${agent ? 'agent' : 'operator'}`}>
      <div className="who">
        {agent ? 'YTC automated assistant' : 'You (operator)'} · {turn.at.slice(11, 19)} UTC
      </div>
      <div>{turn.text}</div>
      {turn.interrupted_after_ms !== undefined && (
        <div className="tiny">You interrupted after {(turn.interrupted_after_ms / 1000).toFixed(1)} s.</div>
      )}
      {agent && reply && (
        <details className="op-sources">
          <summary className="tiny">
            {PATH_LABEL[reply.path]}
            {reply.path !== 'scripted' ? ` · ${(reply.latency_ms / 1000).toFixed(1)} s` : ''}
            {reply.rejected.length ? ` · ${reply.rejected.length} draft${reply.rejected.length > 1 ? 's' : ''} rejected` : ''}
            {sources.length ? ` · cites ${sources.map((f) => f.id).join(', ')}` : ''}
          </summary>
          {sources.map((f) => (
            <p key={f.id} className="tiny">
              <span className="mono">{f.id}</span> {f.text} <span className="mono">[{f.source_event_ids.join(', ')}]</span>
            </p>
          ))}
          {reply.rejected.map((r) => (
            <p key={r.attempt} className="tiny op-rejected">
              Draft {r.attempt} rejected at the {r.stage} check, never spoken: {r.reasons.join('; ')}
            </p>
          ))}
          {reply.model_id && <p className="tiny">Model: {reply.model_id}</p>}
        </details>
      )}
    </div>
  );
}

function FactList({ facts, cited }: { facts: FactView[]; cited: string[] }) {
  const topics = [...new Set(facts.map((f) => f.topic))];
  return (
    <div className="op-facts">
      {topics.map((topic) => (
        <div key={topic} className="stack">
          <span className="eyebrow">{TOPIC_LABEL[topic] ?? topic}</span>
          {facts
            .filter((f) => f.topic === topic)
            .map((f) => (
              <p key={f.id} className={`op-fact ${cited.includes(f.id) ? 'cited' : ''} ${f.kind}`}>
                <span className="mono">{f.id}</span> {f.text}
              </p>
            ))}
        </div>
      ))}
    </div>
  );
}
