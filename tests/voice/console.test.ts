// The operator console renders its idle state without a backend (server-side render, no DOM).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatorConsole } from "../../src/ui/operator/OperatorConsole";

describe("operator console", () => {
  it("starts on standby, with no real line connected", () => {
    const html = renderToString(createElement(OperatorConsole));
    expect(html).toContain("Operator line");
    expect(html).toContain("Standing by");
    expect(html).toContain("No real phone line or emergency service is connected");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("Type a question");
  });
});
