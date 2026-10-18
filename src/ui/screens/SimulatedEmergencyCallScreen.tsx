import { useEffect, useState } from 'react';
import type { CallView } from '../../server/voice/protocol';
import type { Incident, VoiceUtterance } from '../../domain/types';
import { MOCK_OPERATOR_LINES, disconnectCall, operatorSays, operatorSilent, reconnectCall } from '../../domain/voiceAgent';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { ScreenHeader } from '../components/Controls';
import { Icon } from '../components/Icon';
import { SimulatedTag } from '../components/SimulatedTag';
import { fetchDemo } from '../api';
import { callApi } from '../operator/api';

function groundLabel(g: string, incident: Incident): string {
  if (g.startsWith('payload.')) return `shared field "${g.slice('payload.'.length)}"`;
  const e = incident.timeline.find((x) => x.id === g);
  return e ? `log ${fmtTime(e.at)}` : g;
}

function Utterance({ u, incident }: { u: VoiceUtterance; incident: Incident }) {
  const agent = u.speaker === 'agent';
  return (
    <li className={`bubble ${agent ? 'fill agent' : 'fill-2 operator'}`}>
      <span className="t-cap num">
        {agent ? 'Automated assistant' : 'Mock operator'} · {fmtTime(u.at)}
      </span>
      <span className="t-body">{u.text}</span>
      {agent && (
        <span className="t-cap">
          {u.grounds.length ? `Source: ${u.grounds.map((g) => groundLabel(g, incident)).join(', ')}` : 'Source: none (states what is unknown)'}
        </span>
      )}
    </li>
  );
}

export function SimulatedEmergencyCallScreen({ incidentId }: { incidentId: string }) {
  const { state } = useApp();
  const incident = state.incidents.find((i) => i.id === incidentId);
  // Server incidents: the server's voice agent places the call (live demo); this device follows it.
  if (incident?.server) return <ServerCallScreen incident={incident} />;
  return <LocalCallScreen incidentId={incidentId} />;
}

const CALL_POLL_MS = 1500;

/**
 * The simulated call for a server incident, as the host follows it: whether
 * it is ringing or connected, and the transcript. The operator answers on
 * the operator console (#operator), on this device or another.
 */
function ServerCallScreen({ incident }: { incident: Incident }) {
  const { state, go } = useApp();
  const serverId = state.session?.serverId;
  const [callId, setCallId] = useState<string | null>(null);
  const [call, setCall] = useState<CallView | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which call belongs to this alert. Only the live demo places one; the host can see it.
  useEffect(() => {
    if (!serverId) return;
    let alive = true;
    const poll = async () => {
      try {
        const demo = await fetchDemo(serverId);
        if (!alive) return;
        setChecked(true);
        setError(demo === 'unavailable' ? 'The server did not return the live demo state.' : null);
        if (demo && demo !== 'unavailable' && demo.incidentId === incident.id && demo.call) setCallId(demo.call.id);
        else setCallId(null);
      } catch {
        if (alive) setError('Could not check for the simulated call.');
      }
    };
    poll();
    const id = setInterval(poll, CALL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [serverId, incident.id]);

  useEffect(() => {
    if (!callId) return;
    let alive = true;
    const poll = () =>
      callApi.state(callId).then(
        (r) => {
          if (!alive) return;
          setError(null);
          setCall(r.call);
        },
        () => alive && setError('Could not read the simulated call state.'),
      );
    poll();
    const id = setInterval(poll, CALL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [callId]);

  const status = call?.status ?? (callId ? 'ringing' : null);
  const headline =
    status === 'ringing'
      ? 'Calling the simulated operator…'
      : status === 'active'
        ? 'Connected to the simulated operator'
        : status === 'ended'
          ? `Call ended${call?.ended_reason ? ` (${call.ended_reason.replace('_', ' ')})` : ''}`
          : checked
            ? 'No simulated call for this alert'
            : 'Checking…';

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader title={COPY.emergencySimulated} onBack={() => go({ name: 'alert', id: incident.id })} backLabel="Back to alert" />
        <section className="surface card stack rise" role="status" style={{ gap: 8 }}>
          <span className="header" style={{ gap: 10 }}>
            <span className={`dot ${status === 'ringing' || status === 'active' ? 'live' : 'hollow'}`} aria-hidden="true" />
            <span className="t-name grow">{headline}</span>
            <SimulatedTag />
          </span>
          <p className="t-sub">
            {status
              ? 'Nobody acknowledged the alert, so the YTC voice agent is calling about it. It reads only from this alert\'s record.'
              : 'Calls are placed only in the live incident demo.'}{' '}
            {COPY.simulatedCallBanner}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        {call && call.transcript.length > 0 && (
          <ol className="transcript rise rise-2" aria-label="Transcript" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {call.transcript.map((t) => (
              <li key={`${t.turn_index}-${t.speaker}`} className={`bubble ${t.speaker === 'voice_agent' ? 'fill agent' : 'fill-2 operator'}`}>
                <span className="t-cap num">
                  {t.speaker === 'voice_agent' ? 'Automated assistant' : 'Simulated operator'} · {fmtTime(Date.parse(t.at))}
                </span>
                <span className="t-body">{t.text}</span>
              </li>
            ))}
          </ol>
        )}

        {callId && status !== 'ended' && (
          <div className="screen-footer">
            <button type="button" className="btn pbtn on-accent" onClick={() => (window.location.hash = `operator?call=${callId}`)}>
              {status === 'ringing' ? 'Answer as the operator' : 'Open the operator console'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LocalCallScreen({ incidentId }: { incidentId: string }) {
  const { state, store, go } = useApp();
  const [text, setText] = useState('');
  const call = state.voiceCalls[incidentId];
  const incident = state.incidents.find((i) => i.id === incidentId);

  if (!call || !incident) {
    return (
      <div className="screen">
        <div className="narrow">
          <ScreenHeader title={COPY.emergencySimulated} onBack={() => go({ name: 'home' })} />
          <p className="t-lead">No simulated call has started for this alert.</p>
        </div>
      </div>
    );
  }

  const live = call.status === 'connected';
  const say = (line: string) => {
    store.dispatch((d, t) => operatorSays(d, incidentId, line, t));
    setText('');
  };
  const status = call.status === 'connected' ? 'Connected' : call.status === 'ended' ? 'Ended' : call.status === 'failed' ? 'Agent failed' : 'Disconnected';

  return (
    <div className="screen">
      <div className="narrow">
        <ScreenHeader title={COPY.emergencySimulated} onBack={() => go({ name: 'alert', id: incidentId })} backLabel="Back to alert" />
        <section className="surface card stack rise" role="status" style={{ gap: 8 }}>
          <span className="header" style={{ gap: 10 }}>
            <span className={`dot ${live ? 'live' : 'hollow'}`} aria-hidden="true" />
            <span className="t-name grow num">
              {status}
              {call.endedAt ? ` at ${fmtTime(call.endedAt)}` : ''}
            </span>
            <SimulatedTag />
          </span>
          <p className="t-sub">{COPY.simulatedCallBanner}</p>
          <span className="t-cap num">Endpoint: {call.endpoint}</span>
        </section>

        <ol className="transcript rise rise-2" aria-label="Transcript" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {call.utterances.map((u) => (
            <Utterance key={u.id} u={u} incident={incident} />
          ))}
        </ol>

        <div className="screen-footer">
          <span className="lbl">Play the mock operator</span>
          <div className="hscroll">
            {MOCK_OPERATOR_LINES.map((l) => (
              <button key={l} type="button" className="btn chip fill" disabled={!live} onClick={() => say(l)}>
                {l}
              </button>
            ))}
          </div>
          <div className="fill inputbar">
            <label htmlFor="op" className="sr-only">
              Operator question
            </label>
            <input
              id="op"
              className="field field-bare"
              placeholder="Type an operator question"
              autoComplete="off"
              value={text}
              disabled={!live}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && text.trim() && say(text)}
            />
            <button type="button" className="btn ibtn on-accent" aria-label="Say" disabled={!live || !text.trim()} onClick={() => say(text)}>
              <Icon name="send" />
            </button>
          </div>
          <div className="tiles">
            <button type="button" className="btn qtile fill" disabled={!live} onClick={() => store.dispatch((d, t) => operatorSilent(d, incidentId, t))}>
              <Icon name="micOff" />
              Operator silent
            </button>
            <button
              type="button"
              className="btn qtile fill"
              disabled={!live}
              onClick={() => store.dispatch((d, t) => disconnectCall(d, incidentId, 'disconnected', t))}
            >
              <Icon name="x" />
              Disconnect
            </button>
            <button type="button" className="btn qtile fill" disabled={!live} onClick={() => store.dispatch((d, t) => disconnectCall(d, incidentId, 'failed', t))}>
              <Icon name="alert" />
              Agent failure
            </button>
            <button type="button" className="btn qtile fill" disabled={live || incident.status === 'resolved'} onClick={() => store.dispatch((d, t) => reconnectCall(d, incidentId, t))}>
              <Icon name="rotate" />
              Reconnect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
