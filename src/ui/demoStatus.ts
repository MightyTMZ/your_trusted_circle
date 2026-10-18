import type { DemoView } from './api';

export const DEMO_STEP: Record<DemoView['phase'], string> = {
  before_impact: 'The synthetic group is getting settled before the movement change.',
  watching: 'Movement changed. The simulation is waiting for the check-in.',
  checkin_pending: 'No response to the check-in yet. The response window is still open.',
  answered_ok: 'The participant answered. No alert was sent.',
  incident_open: 'No one acknowledged the alert. Escalation is continuing.',
  calling: 'No one picked up the alert. The simulated operator is being called.',
  on_call: 'The simulated operator answered. The voice agent is connected.',
  acknowledged: 'A responder acknowledged the simulated alert.',
  resolved: 'The simulated alert is resolved.',
  stopped: 'The simulation stopped.',
};
