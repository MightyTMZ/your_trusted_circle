import { describe, expect, it } from 'vitest';
import { tick } from '../src/domain/escalation';
import { HOST_RECIPIENT_PREFIX, nextDeadline } from '../src/domain/incident';
import { applyServerIncident, applyServerTimeline, checkInNeedsSync, type ServerIncidentInput } from '../src/domain/serverAlerts';
import { createSession, emptyState, respondToCheckIn, syncServerParticipants, type ParticipantInput } from '../src/domain/session';
import { latestPayloadFor } from '../src/domain/transport';
import type { AppState, CheckIn } from '../src/domain/types';

const host: ParticipantInput = {
  displayName: 'Maya',
  locationSharing: 'group',
  motionMonitoring: false,
  shareLocationWithResponders: true,
  shareNoteWithResponders: false,
  emergencyNote: '',
  backupContacts: [{ name: 'Rin', relation: 'Friend' }],
};

const T0 = Date.parse('2026-10-17T22:00:00.000Z');
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

/** The host's device, after a remote participant (Sam) joined from another phone. */
function hostDevice() {
  const s: AppState = emptyState();
  const { host: h } = createSession(s, { sessionName: 'Friday', durationMin: 240, hostCommitment: true, host }, T0);
  s.session!.serverId = 'ses_server';
  h.serverId = 'ptc_host';
  syncServerParticipants(
    s,
    {
      status: 'active',
      participants: [
        { participantId: 'ptc_host', displayName: 'Maya', role: 'host', isYou: true, deviceOnline: true },
        { participantId: 'ptc_sam', displayName: 'Sam', role: 'participant', isYou: false, deviceOnline: true },
      ],
    },
    T0,
  );
  return { s, hostId: h.id };
}

function serverIncident(over: Partial<ServerIncidentInput> = {}): ServerIncidentInput {
  return {
    id: 'inc_server1',
    participant: { participantId: 'ptc_sam', displayName: 'Sam' },
    trigger: 'help_requested',
    openedAt: iso(0),
    status: 'open',
    acknowledged: null,
    resolved: null,
    steps: [
      { level: 'host', recipients: ['Maya'], notifiedAt: iso(0), dueAt: null },
      { level: 'group', recipients: ['Alex'], notifiedAt: null, dueAt: iso(120) },
      { level: 'emergency_simulated', recipients: ['Emergency services (simulated)'], notifiedAt: null, dueAt: null },
    ],
    log: [
      { at: iso(0), kind: 'checkin', text: 'Sam asked for help.' },
      { at: iso(0), kind: 'notification', text: 'Alert sent to Maya (session host).' },
      { at: iso(1), kind: 'delivery', text: 'Alert delivered to Maya.' },
    ],
    ...over,
  };
}

const alert = { id: 'ntf_job1', incidentId: 'inc_server1', deliveredAt: iso(1) };

describe('server alerts on the host device', () => {
  it('shows the server incident about a remote participant, with its deadline and the delivered alert', () => {
    const { s, hostId } = hostDevice();
    applyServerTimeline(s, { incidents: [serverIncident()], checkIns: [], alerts: [alert] }, hostId);

    expect(s.incidents).toHaveLength(1);
    const inc = s.incidents[0];
    expect(inc.participantId).toBe('ptc_sam');
    expect(inc.server).toEqual({ alertId: 'ntf_job1' });
    expect(inc.currentStep).toBe(0);
    expect(nextDeadline(inc)).toBe(T0 + 120_000);
    expect(inc.steps[0].recipientIds).toEqual([HOST_RECIPIENT_PREFIX + hostId]);
    expect(inc.timeline.map((e) => e.kind)).toEqual(['checkin', 'notification', 'notification']);

    const payload = latestPayloadFor(s, inc.id, HOST_RECIPIENT_PREFIX + hostId);
    expect(payload?.participantName).toBe('Sam');
    // A server alert carries no location; nothing is shown as delivered.
    expect(payload?.lastKnownLocation).toBeUndefined();
  });

  it('is idempotent: the same poll twice changes nothing and adds no duplicate delivery', () => {
    const { s, hostId } = hostDevice();
    const input = { incidents: [serverIncident()], checkIns: [], alerts: [alert] };
    applyServerTimeline(s, input, hostId);
    const once = JSON.stringify(s);
    applyServerTimeline(s, input, hostId);
    expect(JSON.stringify(s)).toBe(once);
    expect(s.notifications).toHaveLength(1);
  });

  it('never escalates a server incident locally, even past its deadline', () => {
    const { s, hostId } = hostDevice();
    applyServerTimeline(s, { incidents: [serverIncident()], checkIns: [], alerts: [alert] }, hostId);
    tick(s, T0 + 10 * 60_000);
    expect(s.incidents[0].currentStep).toBe(0);
    expect(s.incidents[0].steps[1].notifiedAt).toBeUndefined();
  });

  it('takes acknowledgment from the server: escalation stops and the alert id is kept', () => {
    const { s, hostId } = hostDevice();
    applyServerTimeline(s, { incidents: [serverIncident()], checkIns: [], alerts: [alert] }, hostId);
    applyServerIncident(
      s,
      serverIncident({
        status: 'acknowledged',
        acknowledged: { by: 'Maya', at: iso(30) },
        log: [...serverIncident().log, { at: iso(30), kind: 'acknowledgment', text: 'Acknowledged by Maya.' }],
      }),
      hostId,
    );
    const inc = s.incidents[0];
    expect(inc.status).toBe('acknowledged');
    expect(nextDeadline(inc)).toBeUndefined();
    expect(inc.acknowledged).toMatchObject({ name: 'Maya', at: T0 + 30_000, recipientId: HOST_RECIPIENT_PREFIX + hostId });
    expect(inc.server?.alertId).toBe('ntf_job1');
    // Resolution is a separate action.
    expect(inc.resolution).toBeUndefined();
  });

  it('shows a cancel by the person themselves as theirs, not as a responder resolving it', () => {
    const { s, hostId } = hostDevice();
    applyServerTimeline(s, { incidents: [serverIncident()], checkIns: [], alerts: [alert] }, hostId);
    applyServerIncident(
      s,
      serverIncident({
        status: 'resolved',
        resolved: { by: 'Sam', at: iso(40), outcome: 'false_alarm', bySubject: true },
        steps: serverIncident().steps.map((st) => ({ ...st, dueAt: null })),
      }),
      hostId,
    );
    const inc = s.incidents[0];
    expect(inc.status).toBe('resolved');
    expect(inc.resolution).toEqual({ by: 'participant', name: 'Sam', at: T0 + 40_000, outcome: 'false_alarm', note: '' });
    expect(inc.acknowledged).toBeUndefined();
    expect(inc.escalationStoppedAt).toBe(T0 + 40_000);
    expect(nextDeadline(inc)).toBeUndefined();

    // A responder's resolution still reads as theirs.
    applyServerIncident(
      s,
      serverIncident({ status: 'resolved', acknowledged: { by: 'Maya', at: iso(30) }, resolved: { by: 'Maya', at: iso(50), outcome: 'other' } }),
      hostId,
    );
    expect(s.incidents[0].resolution).toMatchObject({ by: 'recipient', recipientId: HOST_RECIPIENT_PREFIX + hostId });
  });

  it('waits until the subject is known on this device', () => {
    const { s, hostId } = hostDevice();
    const unknown = serverIncident({ participant: { participantId: 'ptc_new', displayName: 'Lee' } });
    applyServerTimeline(s, { incidents: [unknown], checkIns: [], alerts: [] }, hostId);
    expect(s.incidents).toHaveLength(0);
  });

  it('ignores sessions that exist only on this device', () => {
    const { s, hostId } = hostDevice();
    delete s.session!.serverId;
    applyServerTimeline(s, { incidents: [serverIncident()], checkIns: [], alerts: [alert] }, hostId);
    expect(s.incidents).toHaveLength(0);
  });
});

describe('check-ins on the participant device of a server-backed session', () => {
  function participantDevice() {
    const { s, hostId } = hostDevice();
    // On Sam's own phone Sam is local; the host is remote. Reuse the shape for the domain rules.
    s.participants.ptc_sam.remote = false;
    const ci: CheckIn = { id: 'chk_local', participantId: 'ptc_sam', observationId: 'obs_1', promptedAt: T0, dueAt: T0 + 60_000, status: 'pending' };
    s.checkIns.push(ci);
    return { s, hostId };
  }

  it('leaves a missed deadline pending locally: the server owns it', () => {
    const { s } = participantDevice();
    tick(s, T0 + 61_000);
    expect(s.checkIns[0].status).toBe('pending');
    expect(s.incidents).toHaveLength(0);
  });

  it('"I need help" opens no local incident and waits to be sent', () => {
    const { s } = participantDevice();
    s.checkIns[0].server = { id: 'chk_server' };
    respondToCheckIn(s, 'ptc_sam', 'chk_local', 'help', T0 + 5_000);
    expect(s.checkIns[0].status).toBe('requested_help');
    expect(s.incidents).toHaveLength(0);
    expect(checkInNeedsSync(s.checkIns[0])).toBe(true);
    s.checkIns[0].server!.responseSent = true;
    expect(checkInNeedsSync(s.checkIns[0])).toBe(false);
  });

  it('closes the local check-in when the server reports it missed', () => {
    const { s } = participantDevice();
    s.checkIns[0].server = { id: 'chk_server' };
    applyServerTimeline(s, { incidents: [], checkIns: [{ id: 'chk_server', status: 'missed' }], alerts: [] }, 'ptc_sam');
    expect(s.checkIns[0].status).toBe('missed');
  });

  it('needs sync until the server has the check-in, then only for an answer', () => {
    const pending: CheckIn = { id: 'c', participantId: 'p', observationId: 'o', promptedAt: 0, dueAt: 1, status: 'pending' };
    expect(checkInNeedsSync(pending)).toBe(true);
    expect(checkInNeedsSync({ ...pending, status: 'responded_ok' })).toBe(false);
    expect(checkInNeedsSync({ ...pending, server: { id: 'x' } })).toBe(false);
    expect(checkInNeedsSync({ ...pending, status: 'responded_ok', server: { id: 'x' } })).toBe(true);
    expect(checkInNeedsSync({ ...pending, server: { id: null, refused: 'incident_open' } })).toBe(false);
  });
});

describe('local-only sessions keep the local scheduler', () => {
  it('a missed check-in still opens a local incident', () => {
    const { s } = hostDevice();
    delete s.session!.serverId;
    s.checkIns.push({ id: 'chk', participantId: 'ptc_sam', observationId: 'obs', promptedAt: T0, dueAt: T0 + 1000, status: 'pending' });
    tick(s, T0 + 2000);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents[0].server).toBeUndefined();
  });
});
