// Red team for the deterministic guard: realistic hallucinations a model might
// write, and correct answers that must still pass. What the guard cannot catch
// is pinned at the bottom: only the entailment judge stops those.
import { describe, expect, it } from "vitest";
import { buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";
import { checkDraft } from "../../src/agent/guard.js";
import { factOf, sheetOf } from "./helpers.js";

const sheet = sheetOf(buildNoResponseScenario());
const t = (topic: string) => factOf(sheet, (f) => f.topic === topic).id;
const impact = factOf(sheet, (f) => f.text.includes("sudden impact")).id;
const unacked = factOf(sheet, (f) => f.text.startsWith("Nobody has acknowledged")).id;
const check = (text: string, id: string) => checkDraft({ intent: "answer", sentences: [{ text, fact_ids: [id] }] }, sheet);

describe("guard red team", () => {
  const cases: [string, string, string][] = [
    ["wrong number", "Their location was recorded 20 minutes ago.", t("location")],
    ["rounded number", "The impact was about 154 m/s².", impact],
    ["shifted time", "The last fix was at 11:51 PM UTC.", t("location")],
    ["age", "They are 22 years old.", t("identity")],
    ["battery %", "Their phone is at 5% battery.", t("device")],
    ["invented name", "Their friend Alex was notified.", t("alerts")],
    ["invented name 2", "Alex was notified.", t("alerts")],
    ["invented street", "They were last near Queen Street.", t("location")],
    ["diagnosis", "They are unconscious.", t("condition")],
    ["cause", "They were probably drugged.", t("incident")],
    ["fall", "It looks like they fell.", impact],
    ["asleep", "They are probably asleep.", t("motion")],
    ["drinking", "They had been drinking heavily.", t("motion_history")],
    ["responders", "Paramedics are on the way.", unacked],
    ["police", "The police have been told.", t("alerts")],
    ["current loc", "They are currently at the rear patio.", t("location")],
    ["right now", "They are at the rear patio right now.", t("location")],
    ["still there", "They're still at the rear patio.", t("location")],
    ["remains", "They remain on the rear patio.", t("location")],
    ["wrong direction", "They were heading west.", t("location")],
    ["companion", "Their boyfriend is with them.", t("description")],
    ["companion 2", "Someone is with them.", t("description")],
    ["clothing", "They are wearing a red jacket.", t("description")],
    ["contradiction", "The host acknowledged the alert.", unacked],
    ["opposite of unknown", "They are conscious and breathing.", t("condition")],
    ["safe", "They are safe.", t("condition")],
    ["battery died", "Their phone battery died.", t("device")],
    ["attack", "Someone attacked them.", t("incident")],
    ["misgendering", "She was last seen on the rear patio.", t("location")],
    ["wrong place lowercase", "They were last seen near the bar.", t("location")],
  ];
  const good: [string, string, string][] = [
    ["location", "Their last-known location is Synthetic Venue A, rear patio, recorded at 11:50:30 PM UTC; their current location is unknown.", t("location")],
    ["coords", "The coordinates were 43.6629, -79.3957, accurate to about 12 metres.", t("location")],
    ["heading", "The phone was moving at 0.9 metres per second, heading east.", t("location")],
    ["condition unknown", "I don't know whether they are conscious or breathing.", t("condition")],
    ["condition unknown 2", "Their condition is unknown, including whether they are safe.", t("condition")],
    ["nobody acked", "Nobody has acknowledged the alert yet.", unacked],
    ["contact unknown", "I can't give their phone number; it isn't part of the record.", t("contact_details")],
    ["impact", "At 11:50:57 PM UTC the phone recorded a sudden impact, followed by 60 seconds with no movement.", impact],
    ["name", "Their name, as they entered it, is Sam (synthetic).", t("identity")],
    ["notes", "They wrote that they carry an inhaler in their left jacket pocket.", t("notes")],
    ["offline", "The phone has been offline since 11:52:40 PM UTC.", t("device")],
    ["no description", "No description or clothing is recorded.", t("description")],
    ["no address", "No street address is recorded; I have coordinates 43.6629, -79.3957.", t("location")],
    ["sequencing starter", "Later, the phone showed light movement.", t("motion_history")],
    ["activity unknown", "The app cannot tell what they were doing.", t("condition")],
    ["timeline words", "Earlier, the phone showed light movement.", t("motion_history")],
    ["possessive", "The participant's condition is unknown.", t("condition")],
    ["medical unknown", "Their medical history is unknown.", t("condition")],
  ];

  it.each(cases)("rejects %s", (_name, text, id) => {
    expect(check(text, id).ok).toBe(false);
  });

  it.each(good)("accepts %s", (_name, text, id) => {
    expect(check(text, id).violations).toEqual([]);
  });

  // Known gap: details that appear nowhere on the sheet and in no risky list.
  it.each([
    ["an invented activity", "They were dancing just before the impact.", impact],
    ["an invented place", "Their last known location was the front entrance.", t("location")],
  ])("leaves %s to the judge", (_name, text, id) => {
    expect(check(text, id).ok).toBe(true);
  });
});
