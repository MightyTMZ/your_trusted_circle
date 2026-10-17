import { describe, expect, it } from "vitest";
import { buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";
import { FactRetriever, relevantFacts, type Embedder } from "../../src/agent/retrieval.js";
import { sheetOf } from "./helpers.js";

const sheet = sheetOf(buildNoResponseScenario());
const top = async (q: string, retriever = new FactRetriever()) => (await retriever.retrieve(sheet.facts, q, 5)).ranked[0]!.fact.topic;

describe("fact retrieval", () => {
  it("routes operator vocabulary to the right facts", async () => {
    expect(await top("What's the address of the emergency?")).toBe("location");
    expect(await top("Is she conscious? Is she breathing?")).toBe("condition");
    expect(await top("Any allergies or medication?")).toBe("notes");
    expect(await top("Is their phone on?")).toBe("device");
    expect(await top("Has anyone been notified?")).toBe("alerts");
    expect(await top("What's their phone number?")).toBe("contact_details");
  });

  it("returns nothing relevant for questions the record cannot answer", async () => {
    const result = await new FactRetriever().retrieve(sheet.facts, "What is the weather like in Paris?", 5);
    expect(relevantFacts(result)).toEqual([]);
  });

  it("fuses dense similarity when an embedder is available", async () => {
    // Toy embedder: one dimension per topic word.
    const axes = ["location", "condition", "notes"];
    const embedder: Embedder = {
      id: "toy",
      embed: async (texts) =>
        texts.map((t) => axes.map((a) => (t.toLowerCase().includes(a === "notes" ? "note" : a === "condition" ? "condition" : "location") ? 1 : 0.01))),
    };
    const result = await new FactRetriever(embedder).retrieve(sheet.facts, "location", 3);
    expect(result.mode).toBe("hybrid");
    expect(result.ranked[0]!.dense_similarity).not.toBeNull();
  });

  it("falls back to lexical ranking when the embedder fails", async () => {
    const embedder: Embedder = { id: "down", embed: async () => Promise.reject(new Error("quota exceeded")) };
    const result = await new FactRetriever(embedder).retrieve(sheet.facts, "where are they", 3);
    expect(result.mode).toBe("lexical");
    expect(result.dense_error).toBe("quota exceeded");
    expect(result.ranked[0]!.fact.topic).toBe("location");
  });
});
