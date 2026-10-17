import { useState } from 'react';
import {
  MOCK_OPERATOR_LINES,
  disconnectCall,
  operatorSays,
  operatorSilent,
  reconnectCall,
} from '../../domain/voiceAgent';
import type { Incident, VoiceUtterance } from '../../domain/types';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtTime } from '../format';
import { SimulatedTag } from '../components/SimulatedTag';

function groundLabel(g: string, incident: Incident): string {
  if (g.startsWith('payload.')) return `shared field "${g.slice('payload.'.length)}"`;
  const e = incident.timeline.find((x) => x.id === g);
  return e ? `log ${fmtTime(e.at)}` : g;
}

function Utterance({ u, incident }: { u: VoiceUtterance; incident: Incident }) {
  return (
    <div className={`utt ${u.speaker}`}>
      <div className="who">
        {u.speaker === 'agent' ? 'Automated assistant' : 'Mock operator'} · {fmtTime(u.at)}
      </div>
      <div>{u.text}</div>
      {u.speaker === 'agent' && (
        <div className="src">
          {u.grounds.length ? `Source: ${u.grounds.map((g) => groundLabel(g, incident)).join(', ')}` : 'Source: none (states what is unknown)'}
        </div>
      )}
    </div>
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
        <button className="btn btn-ghost back" onClick={() => go({ name: 'home' })}>
          Back
        </button>
        <p className="lead">No simulated call has started for this alert.</p>
      </div>
    );
  }

  const live = call.status === 'connected';
  const say = (line: string) => {
    store.dispatch((d, t) => operatorSays(d, incidentId, line, t));
    setText('');
  };

  return (
    <div className="screen">
      <button className="btn btn-ghost back" onClick={() => go({ name: 'alert', id: incidentId })}>
        Back
      </button>
      <div className="stack">
        <div className="row" style={{ gap: 8 }}>
          <span className="eyebrow">Voice agent</span>
          <SimulatedTag />
        </div>
        <h1 className="title">{COPY.emergencySimulated}</h1>
      </div>

      <div className="banner-sim">
        <strong>Simulated.</strong> {COPY.simulatedCallBanner} Endpoint: <span className="mono">{call.endpoint}</span>
        <div className="small" style={{ marginTop: 4 }}>
          Status: {call.status === 'connected' ? 'Connected' : call.status === 'ended' ? 'Ended' : call.status === 'failed' ? 'Agent failed' : 'Disconnected'}
          {call.endedAt ? ` at ${fmtTime(call.endedAt)}` : ''}
        </div>
      </div>

      <div className="transcript">
        {call.utterances.map((u) => (
          <Utterance key={u.id} u={u} incident={incident} />
        ))}
      </div>

      <section className="stack">
        <span className="label">Play the mock operator</span>
        <div className="chips">
          {MOCK_OPERATOR_LINES.map((l) => (
            <button key={l} className="chip" disabled={!live} onClick={() => say(l)}>
              {l}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="Type an operator question"
            value={text}
            disabled={!live}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && say(text)}
          />
          <button className="btn btn-secondary" disabled={!live || !text.trim()} onClick={() => say(text)}>
            Say
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className="chip" disabled={!live} onClick={() => store.dispatch((d, t) => operatorSilent(d, incidentId, t))}>
            Operator silent
          </button>
          <button
            className="chip"
            disabled={!live}
            onClick={() => store.dispatch((d, t) => disconnectCall(d, incidentId, 'disconnected', t))}
          >
            Disconnect
          </button>
          <button className="chip" disabled={!live} onClick={() => store.dispatch((d, t) => disconnectCall(d, incidentId, 'failed', t))}>
            Agent failure
          </button>
          <button className="chip" disabled={live} onClick={() => store.dispatch((d, t) => reconnectCall(d, incidentId, t))}>
            Reconnect
          </button>
        </div>
        <p className="tiny">Every line is logged to the incident timeline. Ending the call never cancels the alert.</p>
      </section>
    </div>
  );
}
