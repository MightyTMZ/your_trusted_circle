import { nextDeadline } from '../../domain/incident';
import type { EscalationStep, Incident } from '../../domain/types';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtCountdown, fmtTime } from '../format';

function stepTitle(step: EscalationStep): string {
  if (step.level === 'host') return 'Session host';
  if (step.level === 'backup') return 'Backup contacts';
  return COPY.emergencySimulated;
}

export function EscalationLadder({ incident, now, showNames }: { incident: Incident; now: number; showNames: boolean }) {
  const { state } = useApp();
  const deadline = nextDeadline(incident);
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {incident.steps.map((step, i) => {
        const names = showNames ? step.recipientIds.map((id) => state.recipients[id]?.name ?? 'Unknown').join(', ') : '';
        const isNext = incident.status === 'open' && i === incident.currentStep + 1;
        const isCurrent = incident.status === 'open' && i === incident.currentStep && step.notifiedAt !== undefined;
        const stopped = incident.status !== 'open' && step.notifiedAt === undefined;
        const state_ =
          step.notifiedAt !== undefined
            ? `Alerted ${fmtTime(step.notifiedAt)}`
            : isNext && deadline !== undefined
              ? `In ${fmtCountdown(deadline - now)}`
              : stopped
                ? 'Not needed'
                : 'Waiting';
        return (
          <li key={step.key} className="row">
            <span className={`av av-sm num ${isCurrent ? 'on-danger' : 'fill'}`}>{i + 1}</span>
            <span className="stack grow">
              <span className="t-name">{stepTitle(step)}</span>
              {names && <span className="t-sub">{names}</span>}
            </span>
            <span className={`num ${isCurrent ? 'tag on-danger' : 't-sub'}`}>{state_}</span>
          </li>
        );
      })}
    </ol>
  );
}
