import { buildOperatorBriefing, selectEvidence } from "../../src/timeline/briefing.js";
import { FIXTURE_INCIDENT_ID, buildNoResponseScenario } from "../../src/timeline/fixtures/no-response.js";
import { OperatorCallAgent, type CallAgentOptions } from "../../src/agent/agent.js";
import { buildFactSheet, type Fact, type FactSheet } from "../../src/agent/facts.js";
import { ModelError, withTimeout, type JsonRequest, type JsonResponse, type ReasoningModel } from "../../src/agent/model.js";

export const SAM = "par_0002";
export const TZ = "UTC";

/** The synthetic no-response night; call_0001 is live and the operator has just asked "What is the situation?". */
export function scenario(overrides: Partial<CallAgentOptions> = {}) {
  const fixture = buildNoResponseScenario();
  const agent = new OperatorCallAgent({
    timeline: fixture.timeline,
    clock: fixture.clock,
    incidentId: FIXTURE_INCIDENT_ID,
    callId: "call_0001",
    timeZone: TZ,
    ...overrides,
  });
  return { ...fixture, agent };
}

export function sheetOf(fixture: ReturnType<typeof buildNoResponseScenario>): FactSheet {
  const events = fixture.timeline.events;
  const briefing = buildOperatorBriefing(events, { incidentId: FIXTURE_INCIDENT_ID, now: fixture.clock.now() });
  return buildFactSheet(briefing, selectEvidence(events, briefing), { timeZone: TZ });
}

export function factOf(sheet: FactSheet, pred: (f: Fact) => boolean): Fact {
  const f = sheet.facts.find(pred);
  if (!f) throw new Error("no matching fact");
  return f;
}

type Script = (req: JsonRequest, call: number) => unknown | Promise<unknown>;

/** A model that answers from a script and records every request. */
export class ScriptedModel implements ReasoningModel {
  readonly requests: JsonRequest[] = [];

  constructor(
    readonly id: string,
    private readonly script: Script,
  ) {}

  async generateJson(req: JsonRequest): Promise<JsonResponse> {
    this.requests.push(req);
    const n = this.requests.length;
    const value = await withTimeout(this.id, req.timeoutMs, async () => this.script(req, n));
    return { value, model_id: this.id };
  }
}

export class BrokenModel implements ReasoningModel {
  constructor(readonly id: string) {}
  async generateJson(): Promise<JsonResponse> {
    throw new ModelError("provider unavailable", "provider_error", this.id);
  }
}

/** Fact ID for the first fact whose text contains the needle, read from the prompt the model was given. */
export function idInPrompt(req: JsonRequest, needle: string): string {
  const line = req.prompt.split("\n").find((l) => /^F\d+ \[/.test(l) && l.includes(needle));
  if (!line) throw new Error(`no fact containing ${needle}`);
  return line.split(" ")[0]!;
}

export const supported = (n: number) => ({
  verdicts: Array.from({ length: n }, (_, i) => ({ claim: i + 1, verdict: "supported", reason: "entailed" })),
});
