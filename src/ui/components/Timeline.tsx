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

/** Vertical timeline. The newest entry gets the accent dot. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {entries.map((e, i) => (
        <li key={e.id} className={`tl ${i === entries.length - 1 ? 'latest' : ''}`}>
          <span className="t-cap num tl-time">{fmtTime(e.at)}</span>
          <span className="tl-rail" aria-hidden="true">
            <span className="tl-dot" />
            <span className="tl-line" />
          </span>
          <span className="tl-body">
            <span className="t-body">{e.text}</span>
            <span className="inline">
              <span className="t-cap">{SOURCE_LABEL[e.source]}</span>
              {e.simulated && <SimulatedTag />}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
