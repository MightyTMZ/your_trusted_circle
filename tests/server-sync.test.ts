import { describe, expect, it } from 'vitest';
import { tick } from '../src/domain/escalation';
import { createSession, emptyState, syncServerParticipants, type ParticipantInput } from '../src/domain/session';
import type { AppState } from '../src/domain/types';

const host: ParticipantInput = {
  displayName: 'Maya',
  locationSharing: 'group',
  motionMonitoring: false,
  shareLocationWithResponders: true,
  shareNoteWithResponders: false,
  emergencyNote: '',
  backupContacts: [{ name: 'Rin', relation: 'Friend' }],
};

function setup() {
  const s: AppState = emptyState();
  const { host: h } = createSession(s, { sessionName: 'Friday', durationMin: 240, hostCommitment: true, host }, 0);
  s.session!.serverId = 'ses_server';
  h.serverId = 'ptc_host';
  return { s, hostId: h.id };
}

const view = (participants: { participantId: string; displayName: string; role: string }[], status = 'active') => ({
  status,
  participants: participants.map((p) => ({ ...p, isYou: false, deviceOnline: true })),
});

describe('server participant sync', () => {
  it('adds people who joined on other devices and keeps the local host', () => {
    const { s, hostId } = setup();
    syncServerParticipants(s, view([{ participantId: 'ptc_host', displayName: 'Maya', role: 'host' }, { participantId: 'ptc_sam', displayName: 'Sam', role: 'participant' }]), 1000);
    expect(Object.keys(s.participants).sort()).toEqual([hostId, 'ptc_sam'].sort());
    expect(s.participants.ptc_sam.remote).toBe(true);
    expect(s.participants[hostId].remote).toBeUndefined();
  });

  it('marks remote people who left, and never removes people created on this device', () => {
    const { s, hostId } = setup();
    syncServerParticipants(s, view([{ participantId: 'ptc_sam', displayName: 'Sam', role: 'participant' }]), 1000);
    syncServerParticipants(s, view([]), 2000);
    expect(s.participants.ptc_sam.status).toBe('left');
    expect(s.participants[hostId].status).toBe('active');
  });

  it('ends the local session when the server says it is over', () => {
    const { s } = setup();
    syncServerParticipants(s, view([], 'expired'), 1000);
    expect(s.session!.status).toBe('ended');
    expect(s.session!.endedReason).toBe('expired');
  });

  it('never simulates a position for someone on another device', () => {
    const { s } = setup();
    syncServerParticipants(s, view([{ participantId: 'ptc_sam', displayName: 'Sam', role: 'participant' }]), 0);
    s.participants.ptc_sam.consent.locationSharing = 'group';
    tick(s, 60_000);
    expect(s.participants.ptc_sam.locations).toEqual([]);
  });

  it('leaves server-backed check-ins pending until the server closes them', () => {
    const { s, hostId } = setup();
    s.checkIns.push({
      id: 'chk_server',
      participantId: hostId,
      observationId: '',
      promptedAt: 0,
      dueAt: 1_000,
      status: 'pending',
      server: { id: 'chk_server' },
    });

    tick(s, 2_000);

    expect(s.checkIns[0]?.status).toBe('pending');
  });
});
