import { describe, expect, it } from "vitest";
import { createDeps } from "../src/server/deps.js";
import { loadConfig } from "../src/server/config.js";
import { DemoRegistry } from "../src/server/demo/live-demo.js";
import { MemoryStore } from "../src/server/store/memory.js";
import type { ParticipantDoc, SessionDoc } from "../src/server/types.js";
import { CallService } from "../src/server/voice/calls.js";

const now = new Date("2026-10-18T07:30:00.000Z");

function host(): ParticipantDoc {
  return {
    participantId: "par_host",
    userId: "usr_host",
    displayName: "Host",
    role: "host",
    joinedAt: now,
    leftAt: null,
    consent: {
      monitoring: true,
      locationSharing: "group",
      shareLocationWithResponders: true,
      shareNoteWithResponders: true,
    },
    consentTextVersion: "consent-v1",
    consentUpdatedAt: now,
    backupContacts: [],
    responderNote: null,
    lastHeartbeatAt: now,
    deviceOnline: true,
  };
}

describe("live incident demo", () => {
  it("adds three synthetic group members and locks the operator scenario to no response", async () => {
    const config = loadConfig({ APP_ORIGIN: "http://localhost:5173", TEST_SIGN_IN: "true" });
    const store = new MemoryStore();
    const calls = new CallService({ wallClock: () => now.getTime() });
    const deps = createDeps(config, store, { calls, now: () => now });
    const session: SessionDoc = {
      _id: "ses_demo",
      code: "DEMO01",
      name: "Operator demo",
      hostUserId: "usr_host",
      status: "active",
      endedReason: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 120 * 60_000),
      endedAt: null,
      suspendedAt: null,
      rules: config.defaultRules,
      participants: [host()],
    };
    await store.insertSession(session);

    const run = await new DemoRegistry(calls).start(deps, session, "par_host", { syntheticParticipants: 3 });
    const prepared = (await store.getSession(session._id))!;

    expect(prepared.participants).toHaveLength(4);
    expect(prepared.participants.filter((p) => p.displayName.includes("(synthetic)"))).toHaveLength(3);
    expect(run.view()).toMatchObject({ unskippable: true });
    expect(run.view().participantId).not.toBe("par_host");
    expect(deps.relay.list(session._id, now)).toHaveLength(3);
  });
});
