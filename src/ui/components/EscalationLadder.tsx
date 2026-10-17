import { nextDeadline } from '../../domain/incident';
import type { EscalationStep, Incident } from '../../domain/types';
import { COPY } from '../copy';
import { useApp } from '../context';
import { fmtCountdown, fmtTime } from '../format';
import { SimulatedTag } from './SimulatedTag';

function stepTitle(step: EscalationStep, names: string): string {
  if (step.level === 'host') return `Session host · ${names}`;
  if (step.level === 'backup') return `Backup contacts · ${names}`;
  return COPY.emergencySimulated;
}

export function EscalationLadder({ incident, now, showNames }: { incident: Incident; now: number; showNames: boolean }) {
  const { state } = useApp();
  const deadline = nextDeadline(incident);
  return (
    <div className="ladder">
      {incident.steps.map((step, i) => {
        const names = showNames ? step.recipientIds.map((id) => state.recipients[id]?.name ?? 'Unknown').join(', ') : '';
        const isNext = incident.status === 'open' && i === incident.currentStep + 1;
        const stopped = incident.status !== 'open' && step.notifiedAt === undefined;
        const cls = step.notifiedAt !== undefined ? 'done' : isNext ? 'next' : stopped ? 'stopped' : '';
        return (
          <div key={step.key} className={`step ${cls}`}>
            <span className="marker" aria-hidden />
            <div className="stack" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{showNames ? stepTitle(step, names) : stepTitle(step, '').replace(/ · $/, '')}</span>
                {step.level === 'emergency_simulated' && <SimulatedTag />}
              </div>
              <span className="small">
                {step.notifiedAt !== undefined
                  ? `Alerted at ${fmtTime(step.notifiedAt)}`
                  : isNext && deadline !== undefined
                    ? `If not acknowledged: ${fmtTime(deadline)} (in ${fmtCountdown(deadline - now)})`
                    : stopped
                      ? 'Not needed. Escalation stopped by acknowledgment.'
                      : 'Waiting on the previous step'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
