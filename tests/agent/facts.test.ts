import { describe, expect, it } from "vitest";
import { buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";
import { SAM, factOf, sheetOf } from "./helpers.js";

describe("fact sheet", () => {
  it("cites real timeline events for every fact", () => {
    const fixture = buildNoResponseScenario();
    const sheet = sheetOf(fixture);
    const ids = new Set(fixture.timeline.events.map((e) => e.event_id));
    expect(sheet.facts.length).toBeGreaterThan(15);
    for (const f of sheet.facts) {
      expect(f.source_event_ids.length, f.text).toBeGreaterThan(0);
      for (const id of f.source_event_ids) expect(ids.has(id), `${f.id} cites ${id}`).toBe(true);
    }
  });

  it("gives the last-known location as last-known, with its age, never as current", () => {
    const fixture = buildNoResponseScenario();
    const loc = factOf(sheetOf(fixture), (f) => f.topic === "location");
    expect(loc.source_event_ids).toEqual([fixture.ids.lastFix.event_id]);
    expect(loc.text).toContain("Last-known location, not live");
    expect(loc.text).toContain("Synthetic Venue A, rear patio, recorded at 11:50 PM UTC");
    expect(loc.text).toMatch(/about \d+ minutes ago/);
    expect(loc.text).toContain("Their current location is unknown.");
    // Coordinates and movement are a second fact, for when the operator asks.
    const detail = sheetOf(fixture).facts.filter((f) => f.topic === "location")[1]!;
    expect(detail.text).toBe(
      "Last-known coordinates: 43.6629, -79.3957, accurate to about 12 metres. The phone was moving at 0.9 metres per second, heading east. No street address is recorded, only coordinates and a place name.",
    );
  });

  it("leaves out an English language preference, which is assumed", () => {
    expect(factOf(sheetOf(buildNoResponseScenario()), (f) => f.topic === "identity").text).toBe("The participant's name, as they entered it, is Sam (synthetic).");
  });

  it("states the saturated impact as a lower bound and never names a cause", () => {
    const sheet = sheetOf(buildNoResponseScenario());
    const impact = factOf(sheet, (f) => f.text.includes("sudden impact"));
    expect(impact.headline).toBe(true);
    expect(impact.text).not.toContain("m/s²");
    expect(impact.text).toContain("cannot tell what caused");
    const strength = factOf(sheet, (f) => f.text.startsWith("The impact at"));
    expect(strength.text).toContain("at least 153.6 m/s²");
    expect(strength.text).toContain("the true strength is unknown");
    const all = sheet.facts.map((f) => f.text).join(" ");
    expect(all).not.toMatch(/\b(fell|fainted|collapsed|drugged|spiked|drunk|unconscious)\b/i);
  });

  it("makes condition, description and contact details explicit unknowns", () => {
    const sheet = sheetOf(buildNoResponseScenario());
    expect(factOf(sheet, (f) => f.topic === "condition").kind).toBe("unknown");
    expect(factOf(sheet, (f) => f.topic === "description").kind).toBe("unknown");
    expect(factOf(sheet, (f) => f.topic === "contact_details").kind).toBe("unknown");
  });

  it("reports the earlier false-alarm check-in and the unanswered latest one separately", () => {
    const checkins = sheetOf(buildNoResponseScenario()).facts.filter((f) => f.topic === "checkin");
    expect(checkins).toHaveLength(2);
    expect(checkins[0]!.text).toContain("confirmed OK");
    expect(checkins[1]!.text).toContain("no response by the 11:54 PM UTC deadline");
  });

  it("never exposes internal IDs or other participants", () => {
    const sheet = sheetOf(buildNoResponseScenario());
    for (const f of sheet.facts) expect(f.text).not.toMatch(/\b(par|con|evt|ntf|inc)_\d+/);
  });

  it("withholds name, notes and location once the participant revokes responder consent", () => {
    const fixture = buildNoResponseScenario();
    fixture.timeline.append({
      type: "consent.revoked",
      participant_id: SAM,
      actor: { kind: "participant", id: SAM },
      provenance: { component: "ui", data_origin: "synthetic_scenario", simulated: false, scenario_id: "agent-test" },
      data: { scopes: ["location.responders", "profile.responders"] },
    });
    const sheet = sheetOf(fixture);
    const text = sheet.facts.map((f) => f.text).join(" ");
    expect(text).not.toContain("Sam");
    expect(text).not.toContain("inhaler");
    expect(text).not.toContain("43.6629");
    expect(factOf(sheet, (f) => f.topic === "location").text).toContain("has not consented to share their location");
    expect(factOf(sheet, (f) => f.topic === "identity").text).toContain("has not consented to share their name");
  });
});
