import type { TimelineEntry } from '../../domain/types';
import { fmtTime } from '../format';
import { SimulatedTag } from './SimulatedTag';

const SOURCE_LABEL: Record<TimelineEntry['source'], string> = {
  detector: 'Detector',
  participant: 'Participant',
  scheduler: 'Scheduler',
  transport: 'Delivery',
  recipient: 'Recipient',
  voice_agent: 'Voice agent',
  mock_operator: 'Mock operator',
  system: 'System',
};

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="timeline">
      {entries.map((e) => (
        <div key={e.id} className="tl">
          <span className="time">{fmtTime(e.at)}</span>
          <div className="stack" style={{ gap: 4 }}>
            <span>{e.text}</span>
            <span className="row" style={{ gap: 6 }}>
              <span className="tiny">{SOURCE_LABEL[e.source]}</span>
              {e.simulated && <SimulatedTag />}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
