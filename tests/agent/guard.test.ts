import { describe, expect, it } from "vitest";
import { buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";
import { checkDraft, parseDraft, type Draft } from "../../src/agent/guard.js";
import { factOf, sheetOf } from "./helpers.js";

const sheet = sheetOf(buildNoResponseScenario());
const loc = factOf(sheet, (f) => f.topic === "location");
const identity = factOf(sheet, (f) => f.topic === "identity");
const condition = factOf(sheet, (f) => f.topic === "condition");
const incident = factOf(sheet, (f) => f.topic === "incident");

const one = (text: string, ...ids: string[]): Draft => ({ intent: "answer", sentences: [{ text, fact_ids: ids }] });
const violations = (d: Draft) => checkDraft(d, sheet).violations;

describe("grounding guard", () => {
  it("accepts a faithful paraphrase of the cited fact", () => {
    expect(violations(one("Their last-known location is Synthetic Venue A, rear patio, at 43.6629, -79.3957, recorded at 11:50 PM UTC.", loc.id))).toEqual([]);
  });

  it("accepts saying something is unknown when the cited fact says so", () => {
    expect(violations(one("I don't know whether they are conscious or breathing; the app has no information about that.", condition.id))).toEqual([]);
  });

  it("rejects a number the cited facts do not contain", () => {
    expect(violations(one("Their location was recorded 20 minutes ago.", loc.id))).toEqual([
      'sentence 1: number "20" is not in the cited facts',
    ]);
  });

  it("rejects a value that exists elsewhere on the sheet but is not cited", () => {
    expect(violations(one("The alert was opened at 11:54:02 PM UTC.", loc.id)).join()).toContain('number "11:54:02"');
    expect(violations(one("The alert was opened at 11:54:02 PM UTC.", incident.id))).toEqual([]);
  });

  it("rejects condition and cause claims", () => {
    const v = violations(one("They probably fell and are unconscious.", incident.id)).join();
    expect(v).toContain('"fell…"');
    expect(v).toContain('"unconscious…"');
    expect(violations(one("They might have been drugged.", incident.id)).join()).toContain("drug");
  });

  it("rejects names and places not in the cited facts", () => {
    expect(violations(one("Sam is at the rear patio.", loc.id)).join()).toContain('"Sam"');
    expect(violations(one("Sam is the participant.", identity.id))).toEqual([]);
    expect(violations(one("They were last near Queen Street.", loc.id)).join()).toContain('"Queen"');
  });

  it("rejects spelled-out numbers not in the cited facts", () => {
    expect(violations(one("That was fifteen minutes ago.", loc.id)).join()).toContain('number word "fifteen"');
  });

  it("rejects internal IDs, links, emails and phone-number-like digits", () => {
    expect(violations(one("See event evt_0246.", loc.id)).join()).toContain("internal ID");
    expect(violations(one("Details are at https://example.com/x.", loc.id)).join()).toContain("URI");
    expect(violations(one("Email help@example.com.", loc.id)).join()).toContain("email");
    expect(violations(one("Call 416 555 0123.", loc.id)).join()).toContain("phone-number-like");
  });

  it("rejects citations of facts that do not exist", () => {
    expect(violations(one("Their location is unknown.", "F999")).join()).toContain("F999");
  });

  it("parses only well-formed drafts", () => {
    expect(parseDraft({ intent: "answer", sentences: [{ text: "Hi.", fact_ids: [] }] }).issues.join()).toContain("at least 1");
    expect(parseDraft({ intent: "answer", sentences: [{ text: "Hi.", fact_ids: ["F1"] }], extra: 1 }).issues.join()).toContain("unknown field");
    expect(parseDraft("not json").issues.length).toBeGreaterThan(0);
    expect(parseDraft({ intent: "answer", sentences: [{ text: "Hi.", fact_ids: ["F1"] }] }).draft).not.toBeNull();
  });
});
