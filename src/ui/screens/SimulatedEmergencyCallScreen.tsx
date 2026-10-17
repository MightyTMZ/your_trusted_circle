import { useState } from 'react';
import type { Incident, VoiceUtterance } from '../../domain/types';
import { MOCK_OPERATOR_LINES, disconnectCall, operatorSays, operatorSilent, reconnectCall } from '../../domain/voiceAgent';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { ScreenHeader } from '../components/Controls';
import { Icon } from '../components/Icon';
import { SimulatedTag } from '../components/SimulatedTag';

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
            <button type="button" className="btn qtile fill" disabled={live} onClick={() => store.dispatch((d, t) => reconnectCall(d, incidentId, t))}>
              <Icon name="rotate" />
              Reconnect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
