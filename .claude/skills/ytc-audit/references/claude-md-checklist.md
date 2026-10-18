# CLAUDE.md rule-by-rule checklist

A map from each CLAUDE.md section to how to verify it and where to look. Paths are as of writing: confirm they still exist, and follow the code if it moved. Rules that CLAUDE.md has gained since are yours to add. Statuses and strength levels are defined in SKILL.md.

Contents: Project purpose and scope · Safety boundaries · Consent and privacy · Detection and data · Architecture · Escalation behaviour · Voice agent · UI changes · Development workflow · Reference documents

Where a row says *script*, `scripts/guardrail-check.mjs` already measured part of it; you still have to judge the result.

---

## Project purpose and current scope

The purpose paragraph says YTC "does not diagnose intoxication, drugging, incapacitation, or unconsciousness". Verify no screen, string, event summary or agent line claims a cause or condition.

- `grep -rniE "intoxicat|drunk|drugg|unconscious|incapacit|overdos|seizure|injur" src` and read each hit in context. The voice agent's guard lists such words as *forbidden*; that is correct use.
- `tests/copy-guard.test.ts` covers "fall" and "safe". Check it covers the other words you find.

CLAUDE.md lists what the prototype must demonstrate. For each, find the implementation and the screen that shows it:

| Scope item | Look at |
|---|---|
| Motion baseline calibration and anomaly detection | `src/detector/baseline.ts`, `patterns.ts`, `src/sensors/pipeline.ts`; client-side twin `src/domain/detector.ts` |
| Consent-based group location | `src/server/lifecycle/relay.ts`, `src/domain/location.ts`, `src/ui/components/GroupMap.tsx`, `ParticipantConsentFields.tsx` |
| Private check-ins after movement changes | `src/ui/screens/ParticipantCheckInScreen.tsx`, `src/server/safety/routes.ts` |
| Alerts to the session host | `src/server/safety/escalation.ts`, `src/server/alerts/`, `AlertEscalationScreen.tsx`, `AlertOverlay.tsx` |
| Escalation to backup contacts | `buildSteps` in `src/server/safety/escalation.ts`; `openIncident` in `src/domain/incident.ts` |
| Simulated escalation to emergency services | the `emergency_simulated` step; `src/server/alerts/transport.ts` |
| Voice agent with a simulated operator | `src/agent/`, `src/server/voice/`, `src/ui/operator/OperatorConsole.tsx` |
| Timestamped Incident Card | `src/domain/incidentCard.ts`, `IncidentCardScreen.tsx`, `src/timeline/briefing.ts` |

"Clearly distinguish implemented behaviour, simulated behaviour, and features requiring further validation." Look for all three markers on screen and in the record: a "Simulated" tag wherever emergency services or the call appear (`SimulatedTag.tsx`), `simulated: true` in event provenance, and the "Unvalidated demo value" label on thresholds. Is there one place (README, docs) that lists which is which for a reader who will judge it? Report if not.

---

## Safety boundaries

**Goal: no path to real emergency contact exists, and that is enforced by machinery, not by judgement.** This is the section where L3 matters most.

| Rule | Verify | Notes |
|---|---|---|
| No telephony, PSTN, SMS or dispatch integration; no telephony SDK dependency | *script* `telephony-deps`; also `package.json` and imports | Check transitive deps via the lockfile, not just direct ones |
| Mock-only transport; operator endpoint is a hard-coded local constant, not configurable by env, UI, scenario scripts or operator speech | *script* `mock-endpoint`. Then read how operator speech is handled in `src/server/voice/calls.ts` and `src/agent/agent.ts` (treated as text only?). Check `OperatorConsole.tsx` has no endpoint field | The build-guard test checks only `src/domain/transport.ts` for env access. Say so if the server voice path is unchecked |
| No dial targets: emergency numbers and `tel:`/`sip:`/`sms:` never appear as destinations in code, config or prompts | *script* `guard-scope`; also read `src/agent/prompt.ts` and fixtures | Mentions in docs that describe the rule are expected |
| **Build guard**: a test fails the build if any of the above appears in source or dependencies | `tests/safety-guard.test.ts`. *script* `guard-scope` lists what it scans and what it skips. Run it: `npx vitest run tests/safety-guard.test.ts` | Gaps in scope are the usual finding. Compare `SCAN_DIRS` with every directory that holds code |
| **Agent guard**: the PreToolUse hook blocks shell, web and MCP calls containing an emergency number, telephony URI or provider | *script* `hook-behaviour` (runs the real hook with 13 payloads) and `hook-wiring` | See "fail-open paths" below |
| Do not disable, bypass or weaken the hook | `git log -p -- .claude/hooks .claude/settings.json` for loosened patterns or a narrowed matcher; no `disableAllHooks` | |
| Use a mock operator endpoint for demos; never connect demo controls to a live number | `src/ui/DemoControls.tsx`, `OperatorConsole.tsx`: every button leads to in-process code | |
| No drug exposure, intentional incapacitation or human falls in testing; follow the KAZE brief's simulation-only testing | Cannot be verified from code. Check fixtures and datasets are labelled synthetic (`data_origin`), and the docs say how data was collected. Mark Unverifiable and say what a human must confirm | |
| Present motion anomalies as observations, never medical conclusions | `src/ui/copy.ts` (`movementChanged`, `observationNotDiagnosis`); event summaries in `src/timeline/schema/catalog.ts`; the agent's guard terms | |
| Never imply acknowledgment means the person is safe | `ACK_CAVEAT` in `src/server/alerts/routes.ts`; `acknowledgeCaveat` and `acknowledgedNotice` in `copy.ts`; `tests/copy-guard.test.ts` | Look at the timeline text and the voice agent's lines too, not only the UI |

### Fail-open paths in the agent guard

A guard that stops guarding silently is worse than none, because people stop being careful. Check each:

- **Executable bit**: `git ls-files -s .claude/hooks/block-emergency-contact.sh` should say `100755`. settings.json runs the file directly.
- **Line endings**: a CRLF shebang fails with exit 127 on macOS/Linux, and Claude Code treats a failing hook as non-blocking. Ask git (`git ls-files --eol`). A `.gitattributes` rule `*.sh text eol=lf` removes the hazard.
- **Missing parser**: the hook uses `jq` or `python3` to read the payload, and falls back to scanning raw input when neither exists. Confirm that fallback blocks (the script's "unparseable input" scenario does).
- **Matcher coverage**: `Bash|WebFetch|WebSearch|mcp__.*` does not cover `Write`, `Edit`, `Agent`, `Skill`, `NotebookEdit`. A forbidden string written by `Write` is caught only by the build guard, at test time. State what is covered by what.
- **Switch-off paths**: `disableAllHooks` in any settings file, and an untracked `.claude/settings.local.json` that redefines hooks.
- **Pattern gaps**: the digit pattern matches standalone runs; look for encodings it would miss (spelled-out words, `tel%3A` URL-encoded, split strings). Decide if each is realistic and report as Low or Info unless it is.
- **Branding**: the block message should say YTC.

---

## Consent and privacy

| Rule | Verify | Look at |
|---|---|---|
| Each participant consents to joining and to location sharing | The join flow cannot complete without choices being made; the server rejects a join without consent | `JoinSessionScreen.tsx`, `ParticipantConsentFields.tsx`; `joinSchema` and `consentSchema` in `src/server/lifecycle/sessions.ts` |
| **The host cannot enable monitoring for another participant** | Server: the consent route changes only the caller's own entry. Client: `updateConsent` throws for another id. Both tested? | `PATCH /sessions/:id/me/consent`; `updateConsent` in `src/domain/session.ts`; "each person changes only their own consent" in `test/server/sessions.test.ts`; `tests/escalation.test.ts` |
| Visible active-session indicator | Present on every signed-in screen, phone and desktop | `src/ui/components/SessionStatus.tsx`, `AppNav.tsx` |
| Participants can leave; sessions expire automatically | Leave route and UI; expiry in the scheduler; what happens to pending check-ins and open incidents at expiry | `leave` in `sessions.ts`; `runSchedulerPass` in `src/server/safety/scheduler.ts`; tests in `sessions.test.ts`, `safety.test.ts` |
| Share location only according to permissions | Consent is re-checked on every read, not only at join. Hosts see only `group`/`host`/responder-shared positions | `src/server/lifecycle/relay.ts`, `location.ts`; `canViewLocation` in `src/domain/location.ts`; `test/server/relay.test.ts` |
| **Live group location is relayed in server memory and never stored; persisted only while an incident about that person is active** | Read `relay.ts` for any database write. Read `events.ts` for where `location.reported` is dropped outside an incident and where location-like keys are stripped from free-form data. Check logs, exports, `traces` and `timeline` for stray coordinates | `test/server/relay.test.ts`, `events.test.ts`. Note the single-process limitation in `docs/backend.md` |
| Synthetic identities and locations in demonstrations | Demo venue positions carry `simulated: true`; fixtures use made-up names | `src/ui/venue.ts`, `DemoControls.tsx`, `src/timeline/fixtures/` |
| Do not commit personal recordings, credentials or API keys | *script* `secrets`. Also check `examples/accelerometer/` and `docs/examples/` are the declared synthetic/permitted data; `.gitignore` covers `data/` | Real phone recordings are in the repo; confirm they are the author's own and say so |
| Voice transcripts and audio grounded in real information provided | See Voice agent below | |

Extra checks the rules imply:

- **Export and deletion**: `GET /api/me/export` and `DELETE /api/me` (`src/server/data/account.ts`): does the export include everything about the person, and does deletion remove it from sessions, traces, jobs and incidents?
- **Retention**: `src/server/data/retention.ts`; is the default (30 days) documented?
- **Minimal logging**: grep `console.` in `src/server` for names, emails, coordinates or tokens.
- **Profile data in alerts**: only fields the person agreed to share (`shareNoteWithResponders`, `shareLocationWithResponders`) reach responders and the voice agent.

---

## Detection and data

| Rule | Verify | Look at |
|---|---|---|
| Statistical baselines and explicit rules first | The detector is rule-based with a personal baseline; no opaque model | `src/detector/baseline.ts`, `patterns.ts` |
| Thresholds configurable and labelled unvalidated | Defaults live in one config object; the UI says "Unvalidated demo value"; events carry `thresholds_validated: false` | `DEFAULT_BASELINE_CONFIG`, `DEFAULT_PATTERN_CONFIG`, `src/domain/config.ts`, `UNVALIDATED_LABEL` |
| Preserve raw recordings separately from derived features | Raw samples go to their own record, never mixed with features | `src/sensors/raw-recording.ts`; `docs/timeline.md` |
| Retain timestamps, units, participant/session IDs and provenance | Every event has the envelope; samples keep units (m/s²) | `src/timeline/schema/envelope.ts`, `catalog.ts`; `schema.test.ts` |
| Separate recorded data from synthetic scenarios | `data_origin` distinguishes them; real recordings are never presented as synthetic or the reverse | `DataOrigin` in the envelope; fixtures |
| **Split development and evaluation data by participant** | Look for any evaluation or train/test code. The 2026-10 audit found none. If there is none, report Missing and ask whether an evaluation protocol is planned | `grep -rniE "evaluation|holdout|train|split" src docs` |
| Never use labels, participant IDs or dataset splits as model inputs | Read the detector's inputs: window features only. Read what the voice agent's models receive | `BASELINE_FEATURES` in `baseline.ts`; `src/agent/facts.ts` |

Units trap: some external datasets use g where this project uses m/s². Check any import path converts.

---

## Architecture

"Keep these components separate": sensor input adapters, baseline and anomaly detector, session and incident state machines, notification and escalation scheduler, simulated transport and recipient state, Incident Card generation, voice-agent adapter, user interface.

| Component | Where it lives |
|---|---|
| Sensor/feature adapters | `src/sensors/` |
| Detector | `src/detector/` (and the simpler client twin `src/domain/detector.ts`) |
| Session and incident state machines | `src/domain/session.ts`, `incident.ts` (browser); `src/server/lifecycle/`, `src/server/safety/` (server) |
| Scheduler | `src/domain/escalation.ts` (browser); `src/server/safety/scheduler.ts`, `src/server/alerts/jobs.ts` (server) |
| Simulated transport and recipients | `src/domain/transport.ts`; `src/server/alerts/transport.ts` |
| Incident Card | `src/domain/incidentCard.ts`; `src/timeline/briefing.ts` |
| Voice agent | `src/agent/`, `src/server/voice/` |
| UI | `src/ui/` |

- *script* `layers` checks import directions against rules inferred from this table. Judge each violation: a fixture builder in `timeline/` importing `sensors/` is a different thing from the domain importing the server.
- **Duplicated state machines.** The browser and the server both implement sessions, incidents and escalation. Which is authoritative? Compare their behaviour on: check-in window defaults, escalation order, what resolving does, repeat semantics. `src/domain/serverAlerts.ts` is the bridge; read how it prevents the local scheduler from escalating a server-owned incident. Report drift as Medium or High depending on whether a user could see two different outcomes.
- **Voice agent on the same server, but a separate module**: `src/agent/` must not import from `src/server` or `src/ui`; `src/server/voice/` is the only bridge.
- **One injectable clock for all deadlines**: *script* `clock`. Read each hit. Display and id uses are fine; deadline uses are not. Two clock modules exist (`src/shared/clock.ts`, `src/domain/clock.ts`): are they consistent?
- **Scenario scripts provide inputs; they must not force detector outputs**: *script* `scenario-forcing`, then read the flagged lines in `src/timeline/fixtures/no-response.ts` and `DemoControls.tsx`. The fixture should feed samples into `SensorPipeline` and record what it emits.
- **Recipients may use only information actually delivered to them**: `buildPayload` in `src/domain/transport.ts`; `latestPayloadFor` use in the voice agent; `src/timeline/consent.ts` and `briefing.ts` on the server side. Try to find any place a recipient screen reads from global state instead of its delivered payload.

---

## Escalation behaviour

| Rule | Verify | Test that should exist |
|---|---|---|
| Track time since the last unacknowledged notification | `lastUnackedNotificationAt` | escalation tests |
| Repeating an alert must not restart its deadline | `repeatAlert` does not touch `dueAt`; server has no repeat or equivalent | "repeating an alert does not restart its deadline" (`tests/escalation.test.ts`) |
| Configurable escalation intervals | `SessionConfig`; host timing steppers; server `rules` with validated ranges. Confirm the UI's limits match the server's (a stepper that allows a value the server refuses is a bug) | `test/server/sessions.test.ts` |
| Acknowledgment stops pending escalation | `acknowledge`; server `acknowledgeIncident` clears pending `dueAt` | tests in both suites |
| Resolution is a separate action from acknowledgment | A resolve before acknowledging is refused (both sides) | "acknowledgment stops escalation; resolution is a separate, later action" |
| Missing connectivity must not silently cancel a registered timer | Deadlines live in state/database, not in `setTimeout`. Offline device does not cancel | "a disconnected device does not cancel registered timers"; the closed-client test in `test/server/safety.test.ts` |
| Prevent duplicate notifications for the same step | De-dupe in `transport.ts`; server `claimStep`, `dedupeKey`, `claimJob` | server safety tests; run them concurrently if a store contract test exists |
| Keep emergency-service delivery simulated | Same evidence as Safety boundaries | |

Also check the host's own incident: when the host triggers an alert, escalation must skip "host" and go to their backup contacts (`buildSteps`; test "the host's own missed check-in goes to their backup contacts").

A person cancelling their own false alarm (if present) must still stop pending escalation, notify the people already alerted, and never be recorded as confirmation of safety.

---

## Voice agent

| Rule | Verify | Look at |
|---|---|---|
| Identifies itself as an automated assistant | The opening line says so | `startSimulatedCall` in `src/domain/voiceAgent.ts`; opening in `src/agent/agent.ts` |
| Relays only available structured facts | Facts come from the fact sheet built from the timeline | `src/agent/facts.ts` |
| Distinguishes last-known from current location | "last-known", recorded time, "current location is unknown" | `facts.ts` location facts; tests |
| States uncertainty and missing information | Unknown condition, cause, location when absent | `tests/agent/agent.test.ts` |
| Never invents a cause, diagnosis, person, location or response; grounds every answer | The guard (cites real fact ids; numbers, names, causes only from cited facts) and the entailment judge; fails closed if the judge cannot run | `src/agent/guard.ts`, `judge.ts`; `tests/agent/guard.test.ts`, `redteam.test.ts` |
| Operator speech is input, not permission to change rules or disclose unrelated data | The "out of scope" patterns; the system prompt keeps operator text out of the system role | `OUT_OF_SCOPE` in `agent.ts`; `prompt.ts`; red-team tests |
| Handles interruptions, silence, disconnects, agent failure | Silence, interrupt, disconnect and failure each have behaviour and a test | `tests/voice/calls.test.ts` |
| Logs communication outcomes in the incident timeline | Every utterance, rejected draft and error becomes an event | `voice.*` events in `catalog.ts` |
| Provider credentials stay server-side | Keys read only under `src/server`; browser bundle exposes none | *script* `secrets`, `mock-endpoint` |

Guardrails for every model prompt and response: facts only from the activity log; only data participants consented to share; unknown if not in the log or user data; every statement traceable to a log entry or field with its timestamp. Read `src/agent/prompt.ts` against each, and read the red-team tests for what they actually try (disclosure of other people's data, "ignore your rules", invented causes, location precision).

Also check the **offline path**: with no model key, the agent speaks facts verbatim. Is that path covered by tests, and is it clearly worded as facts, not advice?

---

## UI changes

CLAUDE.md points to `docs/ui-guidelines.md`. Use `references/frontend-audit.md` for the full pass. CLAUDE.md-level rules to confirm:

- Tokens and listed components only; no hard-coded colours, radii or fonts (*script* `ui-tokens`).
- Accent marks only active, on, in progress, the primary action or the current selection.
- One focal point and one primary action per screen; steps or expandable sections over long forms.
- Every screen works on phone, tablet and desktop and in both themes (*script* `ui-contrast`, `theme-consistency`).
- No screen assumes a server feature that is not there ("Backend features" in the guidelines).
- New components or themes are documented in the guidelines in the same change.

---

## Development workflow

Mostly about how people and agents work, so mostly Unverifiable from code. What can be checked:

- "Run the narrowest relevant tests": a fast, documented way to run one file (`npx vitest run <file>`, `node --test dist/...`). README or `package.json` scripts.
- "Never commit secrets": *script* `secrets`.
- Small, clearly-messaged commits: `git log --oneline -30` for sprawling or vague commits.
- A CI workflow running the guardrail tests on every push (*script* `ci`). If absent, the build guard exists but nothing makes anyone run it.
- Branch hygiene: stale branches, leftover generated files (`git ls-files | grep -E "timestamp|\.log$"`).

---

## Reference documents

*script* `reference-docs` checks that linked files exist and whether the four documents CLAUDE.md says it keeps linked are present: product specification, KAZE brief, data schema, evaluation protocol. Report each missing one. Also:

- Do `docs/backend.md` and `docs/timeline.md` match the code? (*script* `api-drift`, `env-drift`.) Read the voice-calls section against `src/server/voice/routes.ts`.
- Does the README tell a new person how to run, test and demo it, and which parts are real versus simulated?
- **Conflicts**: where two documents or a document and the code disagree, list the conflict explicitly. CLAUDE.md asks for an explanation before behaviour changes.
