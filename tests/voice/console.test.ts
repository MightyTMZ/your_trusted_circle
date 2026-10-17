// The operator console renders its idle state without a backend (server-side render, no DOM).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatorConsole } from "../../src/ui/operator/OperatorConsole";

describe("operator console", () => {
  it("starts idle, labelled simulated, with one way in", () => {
    const html = renderToString(createElement(OperatorConsole));
    expect(html).toContain("Simulated emergency operator");
    expect(html).toContain("simulated emergency services only");
    expect(html).toContain("Answer the simulated call");
  });
});
