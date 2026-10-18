# Report template

Write the report in this shape. The reader is deciding what to fix next, possibly before a demo, so lead with what matters and keep every finding self-contained. Plain words; no finding without evidence.

```markdown
# YTC audit: <branch or commit>, <date>

**Scope:** <what was audited: whole repo / front end / back end / diff>.  **Not covered:** <what was skipped and why>.

## Verdict
<Two or three sentences. Is the safety story sound? What are the one or two things that could embarrass the project or hurt a user?>

| | Count |
|---|---|
| Critical | n |
| High | n |
| Medium | n |
| Low | n |

## Guardrail strength
| Guardrail (CLAUDE.md) | Strength | Evidence | Gap |
|---|---|---|---|
| No real emergency path: build guard | L2 | tests/safety-guard.test.ts, 3 assertions | Scans src/ and tests/ only; test/, scripts/, .claude/ unscanned |
| No real emergency path: agent hook | L3 | hook run with 13 payloads, 15/15 breakages caught by self-test | CRLF risk in Windows checkouts |
| … | | | |

L3 proven · L2 enforced, unproven or gapped · L1 convention only · L0 absent. Also list **fail-open paths** found, even when the strength is high.

## Critical and high findings
### 1. <Short name> (Critical|High)
- **Rule:** <CLAUDE.md section and sentence>
- **Evidence:** `path:line`, or command and output
- **What it means:** <consequence in plain words>
- **Smallest fix:** <one or two sentences>

## Medium and low findings
<Same shape, shorter. Group related ones.>

## Rule-by-rule status
| CLAUDE.md section | Rule | Status | Evidence |
|---|---|---|---|
| Safety boundaries | Mock-only transport | Enforced | … |
(Enforced / Implemented / Partial / Missing / Unverifiable. One row per rule you assessed.)

## Front end
<Design rules, safety-critical UI, accessibility, states. Say which widths and themes you actually looked at. If you could not use a browser, say so.>

## Back end
<Deadlines, exactly-once, auth, privacy, voice routes, state-machine drift.>

## Checks run
| Command | Result |
|---|---|
| guardrail-check.mjs | n pass, n warn, n fail |
| typecheck / vitest / node tests / build | … |
Known environment failures (for example the Windows line-ending test) are named here, not counted as defects.

## Conflicts between documents and code
<Each one stated plainly with both sides quoted or cited. Do not pick a winner.>

## Suggested order of work
1. <Fix>  (<severity>, <effort>)
2. …
```

## Writing guidance

- **Lead with consequence, not mechanism.** "A change that adds a forbidden string to `test/` would pass the build" beats "SCAN_DIRS omits test".
- **Be exact about confidence.** "Verified by running" and "inferred from reading" are different claims. Heuristic script items are inferred until you open them.
- **Do not pad.** A clean area gets one line. A section with nothing to say is deleted, not filled.
- **Name the smallest fix**, but do not make it. The audit is read-only; offer to implement.
- **Group repeated causes.** Twelve hard-coded colours from one file is one finding.
- **Do not inflate.** Dev-only dependency advisories, known environment failures and intentional documentation mentions are not defects.
- **Credit what is solid**, briefly: the person reading it needs to know which guardrails they can lean on.
