/**
 * Two devices, two accounts, one server: a host and a participant each keep
 * their own local store, as two browsers would, and talk to the real API
 * (fake sign-in provider, fake clock, real scheduler passes). The responses
 * go through the same client mapping the app uses.
 */
import { describe, expect, it } from 'vitest';
import { tick as localTick } from '../src/domain/escalation';
import { HOST_RECIPIENT_PREFIX, nextDeadline } from '../src/domain/incident';
import { applyServerIncident, applyServerTimeline } from '../src/domain/serverAlerts';
import { createSession, emptyState, hydrateServerSession, respondToCheckIn, syncServerParticipants, type ParticipantInput } from '../src/domain/session';
import type { AppState } from '../src/domain/types';
import { T0, hostSession, join, setup, signIn, type Client } from '../test/server/helpers';

const SEC = 1000;
const input = (name: string): ParticipantInput => ({
  displayName: name,
  locationSharing: 'group',
  motionMonitoring: true,
  shareLocationWithResponders: true,
  shareNoteWithResponders: false,
  emergencyNote: '',
  backupContacts: [{ name: 'Rin', relation: 'Friend' }],
});

async function twoDevices() {
  const env = setup();
  const maya = await signIn(env.app, 'maya');
  const sam = await signIn(env.app, 'sam');

  // Host's browser: local session first, then the server's (HostSetupScreen).
  const server = await hostSession(maya);
  const hostState: AppState = emptyState();
  const { host } = createSession(hostState, { sessionName: 'Friday', durationMin: 240, hostCommitment: true, host: input('Maya') }, T0);
  hostState.session!.serverId = server.id;
  host.serverId = server.me.participantId;
  const code = (await maya.call('GET', `/api/sessions/${server.id}`)).body.session.code as string;

  // Participant's browser: joins with the code (JoinSessionScreen).
  const joined = await join(sam, code);
  const samState: AppState = emptyState();
  const samId = hydrateServerSession(samState, { serverSession: JSON.parse(JSON.stringify(joined)), code, myInput: input('Sam') }, T0);

  // Host's participant poll picks Sam up.
  syncServerParticipants(hostState, (await maya.call('GET', `/api/sessions/${server.id}`)).body.session, T0);

  /** One alert poll, as the LiveLocationProvider runs it. */
  const poll = async (c: Client, state: AppState, viewerId: string, isHost: boolean) => {
    const timeline = (await c.call('GET', `/api/sessions/${server.id}/timeline`)).body;
    const alerts = isHost ? (await c.call('GET', '/api/alerts')).body.alerts : [];
    applyServerTimeline(state, { incidents: timeline.incidents, checkIns: timeline.checkIns, alerts }, viewerId);
  };
  return { ...env, maya, sam, server, hostState, hostId: host.id, samState, samId, poll };
}

describe('host and participant on two devices', () => {
  it('a missed check-in on the participant phone alerts the host; acknowledgment stops escalation on both', async () => {
    const { advance, tick, maya, sam, server, hostState, hostId, samState, samId, poll } = await twoDevices();

    // Sam's phone: a check-in starts locally and is reported to the server.
    samState.checkIns.push({ id: 'chk_local', participantId: samId, observationId: 'obs', promptedAt: T0, dueAt: T0 + 60 * SEC, status: 'pending' });
    const started = await sam.call('POST', `/api/sessions/${server.id}/checkins`, { reason: 'movement_changed' });
    expect(started.status).toBe(201);
    samState.checkIns[0].server = { id: started.body.checkIn.id };

    // Sam doesn't answer. The phone's own deadline opens nothing locally.
    localTick(samState, T0 + 61 * SEC);
    expect(samState.incidents).toHaveLength(0);

    // The server's deadline passes and it alerts the host.
    advance(61 * SEC);
    await tick();
    await poll(maya, hostState, hostId, true);
    await poll(sam, samState, samId, false);

    const hostView = hostState.incidents[0];
    const samView = samState.incidents[0];
    expect(hostView.id).toBe(samView.id);
    expect(hostView.participantId).toBe(samId);
    expect(hostView.status).toBe('open');
    expect(hostView.server?.alertId).toBeTruthy();
    expect(samView.status).toBe('open');
    expect(samState.checkIns[0].status).toBe('missed');
    const deadline = nextDeadline(hostView)!;
    expect(deadline).toBeGreaterThan(T0 + 61 * SEC);

    // Host acknowledges through the server, as AlertEscalationScreen does.
    const ack = await maya.call('POST', `/api/alerts/${hostView.server!.alertId}/acknowledge`);
    expect(ack.status).toBe(200);
    applyServerIncident(hostState, ack.body.incident, hostId);
    expect(hostState.incidents[0].status).toBe('acknowledged');

    // Past the old deadline: no further step on the server, on either device.
    advance(10 * 60 * SEC);
    const pass = await tick();
    expect(pass.stepsEscalated).toBe(0);
    await poll(maya, hostState, hostId, true);
    await poll(sam, samState, samId, false);
    for (const s of [hostState, samState]) {
      localTick(s, deadline + 10 * 60 * SEC);
      const inc = s.incidents[0];
      expect(inc.status).toBe('acknowledged');
      expect(inc.acknowledged?.name).toBe('Maya');
      expect(nextDeadline(inc)).toBeUndefined();
      expect(inc.steps.filter((x) => x.notifiedAt !== undefined)).toHaveLength(1);
    }
    expect(hostState.incidents[0].acknowledged?.recipientId).toBe(HOST_RECIPIENT_PREFIX + hostId);

    // Resolution is a separate, later step.
    expect(samState.incidents[0].resolution).toBeUndefined();
    const res = await maya.call('POST', `/api/incidents/${hostView.id}/resolve`, { outcome: 'false_alarm' });
    expect(res.status).toBe(200);
    await poll(sam, samState, samId, false);
    expect(samState.incidents[0].status).toBe('resolved');
  });

  it('"I need help" from a check-in reaches the host once, with no local duplicate', async () => {
    const { tick, maya, sam, server, hostState, hostId, samState, samId, poll } = await twoDevices();
    samState.checkIns.push({ id: 'chk_local', participantId: samId, observationId: 'obs', promptedAt: T0, dueAt: T0 + 60 * SEC, status: 'pending' });
    const started = await sam.call('POST', `/api/sessions/${server.id}/checkins`, { reason: 'movement_changed' });
    samState.checkIns[0].server = { id: started.body.checkIn.id };

    respondToCheckIn(samState, samId, 'chk_local', 'help', T0 + 5 * SEC);
    expect(samState.incidents).toHaveLength(0);
    const answered = await sam.call('POST', `/api/checkins/${started.body.checkIn.id}/respond`, { response: 'help' });
    expect(answered.body.incidentId).toBeTruthy();

    await tick(); // delivers the queued alert, as the server does every second
    await poll(maya, hostState, hostId, true);
    await poll(sam, samState, samId, false);
    expect(hostState.incidents).toHaveLength(1);
    expect(samState.incidents).toHaveLength(1);
    expect(hostState.incidents[0].trigger).toBe('help_requested');
    expect(hostState.notifications).toHaveLength(1);
  });

  it('the help button reaches the host, and the participant cannot acknowledge their own alert', async () => {
    const { maya, sam, server, hostState, hostId, samState, samId, poll } = await twoDevices();
    const help = await sam.call('POST', `/api/sessions/${server.id}/help`);
    expect(help.status).toBe(201);
    await poll(maya, hostState, hostId, true);
    await poll(sam, samState, samId, false);
    expect(hostState.incidents[0].status).toBe('open');
    expect(samState.incidents[0].server?.alertId).toBeUndefined();

    const alerts = (await sam.call('GET', '/api/alerts')).body.alerts;
    expect(alerts).toHaveLength(0);
    const resolve = await sam.call('POST', `/api/incidents/${help.body.incidentId}/resolve`, { outcome: 'false_alarm' });
    expect(resolve.status).toBe(403);
  });
});
