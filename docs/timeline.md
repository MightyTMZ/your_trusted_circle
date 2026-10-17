# Incident timeline (JSONL)

The timeline is the single, append-only record of everything that happens
in a session: consent, sensor observations, check-ins, alerts, escalation,
simulated emergency contact and every voice-agent utterance. The Incident
Card and the voice agent read from it. Nothing else is a source of facts.

Code: `src/timeline/`. Example: [`examples/no-response-incident.jsonl`](./examples/no-response-incident.jsonl)
(regenerate with `npm run example:timeline`).

## Module layout

| File | Responsibility |
| --- | --- |
| `schema/validate.ts` | Small, strict runtime validator with TypeScript inference. Unknown fields are rejected. |
| `schema/envelope.ts` | Shared envelope vocabulary: actors, components, data origins, consent scopes, sensitivity. |
| `schema/catalog.ts` | Every event type: payload schema, scoping, sensitivity, safety rules, summary template. |
| `canonical.ts` | Canonical JSON + sha256 hashing; fixed JSONL field order. |
| `timeline.ts` | `Timeline`: validates, sequences, hash-chains and commits events; `restore()` re-verifies stored logs. |
| `sinks.ts` | Output targets (`MemorySink`, `JsonlFileSink`). Add new sinks by implementing `TimelineSink`. |
| `jsonl.ts` | Read/write JSONL, report malformed lines by number. |
| `briefing.ts` | `buildOperatorBriefing()`: consent-filtered, cited view for the voice agent. |
| `fixtures/` | Synthetic timelines for tests and docs. |

Time comes from the injected `Clock` (`src/shared/clock.ts`); IDs from an
injected `IdGenerator` (`src/shared/ids.ts`). Both are deterministic in tests.

## Line format

One UTF-8 JSON object per line, `\n`-terminated, fields always in this order:

| Field | Meaning |
| --- | --- |
| `schema_version` | Envelope version (`"1.0"`). |
| `seq` | Gap-free position in the session timeline, from 1. |
| `event_id` | `evt_…`, unique within the session. |
| `occurred_at` | When it happened in the world (ISO 8601 UTC, ms). |
| `recorded_at` | When the timeline recorded it (injected clock). Never decreases. |
| `type` / `category` | Dotted type (`checkin.missed`) and its prefix (`checkin`). |
| `session_id` / `incident_id` / `participant_id` | Scope. `participant_id` is who the event is *about*. |
| `summary` | Deterministic sentence rendered from `data`. Readers can stop here. |
| `actor` | `{kind, id}`: who or what caused it. |
| `provenance` | `{component, data_origin, simulated, scenario_id?, raw_ref?, producer?}`. |
| `caused_by` | Earlier `event_id`s this follows from (anomaly → check-in → missed → incident). |
| `data` | Type-specific payload. Units are in field names (`_ms`, `_m`) or an explicit `unit`. |
| `prev_hash` / `hash` | sha256 chain over canonical JSON. Any edit, reorder or deletion is detected on restore. |

`data_origin` separates `live_device`, `recorded_dataset`,
`synthetic_scenario` and `system_generated` data. `raw_ref` points at raw
recordings stored elsewhere; the timeline holds derived features only.

## Event catalog

Sensitivity `location`/`profile` means the payload reaches responders only
under the participant's `location.responders`/`profile.responders` consent.

| Category | Types | Notes |
| --- | --- | --- |
| session | `created`, `participant_joined`, `participant_left`, `expired`, `ended` | `created` records the escalation policy, flagged `thresholds_validated: false`. |
| consent | `granted`, `revoked` | Self-only: the actor must be the participant. Scopes: `monitoring`, `location.group`, `location.responders`, `profile.responders`. |
| profile | `shared` | Sensitivity `profile`. Self-reported name, pronouns, language, emergency notes. |
| location | `reported` | Sensitivity `location`. Always a last-known fix with `fix_at` and `accuracy_m`. |
| sensor | `baseline_calibrated`, `motion_anomaly_observed`, `stream_interrupted`, `stream_resumed` | Anomalies carry value, baseline, z-score, window and the rule with `threshold_validated: false`. |
| connectivity | `device_offline`, `device_online` | Offline never cancels timers. |
| checkin | `prompted`, `responded`, `missed` | `responded.response` is `confirmed_ok`, `requested_help` or `duress`. |
| incident | `opened`, `acknowledged`, `resolved` | Acknowledgment and resolution are separate. Acknowledgment confirms receipt only. |
| notification | `sent`, `delivered`, `viewed`, `delivery_failed` | `sent` lists `delivered_fact_event_ids`: exactly what the recipient was told. Repeats keep the same `notification_id` with `attempt > 1`. |
| escalation | `step_scheduled`, `step_fired`, `step_cancelled` | `deadline_basis_event_id` anchors the deadline; repeats do not move it. |
| emergency | `simulated_dispatch_requested` | Must be `simulated: true`; endpoint fixed to `mock-operator-local`. |
| voice | `call_started`, `utterance`, `silence_detected`, `agent_error`, `call_ended` | Must be simulated. Agent utterances must cite `grounding_event_ids`. Both sides of the call are logged. |

## Enforced on append

- Payload matches its schema; unknown types and fields are rejected.
- Incident-scoped types need an `incident_id` that was opened earlier; an incident cannot be opened twice.
- `caused_by` and `trigger_event_id` reference earlier events only.
- Emergency and voice events are simulated and target only the mock endpoint.
- Consent and profile events are performed by the participant themselves.
- `occurred_at` is not in the future beyond a skew tolerance (default 2 s).
- Sinks are written before the event is committed; a failing sink rejects the append.

The timeline enforces integrity, not business flow: when to escalate or
expire is the job of the session/incident state machines and scheduler.

## Operator briefing (voice-agent input)

`buildOperatorBriefing(events, { incidentId, now })` returns a JSON object with:

- `incident`: state (`open` / `acknowledged` / `resolved`), trigger, who acknowledged or resolved.
- `participant`: profile fields only if consented, else `not_consented` / `not_provided`.
- `location`: last-known fix with `age_ms`; `is_current` is always `false`.
- `device`, `escalation`, `notifications`: current status, each with source event IDs.
- `facts`: chronological `{event_id, seq, occurred_at, age_ms, type, statement, simulated}`.
  `factsToJsonl()` emits them as JSONL for the model.
- `redactions`: events withheld and why (no content).
- `unknowns`: what the agent must say it does not know.
- `disclaimers`: automated assistant, simulated contact, observations not diagnoses, acknowledgment ≠ safe.

Only the incident's events, the subject participant's own events and
`session.created` are included; other participants never appear. Consent is
evaluated as of the briefing: revoking a scope or leaving the session
withdraws earlier data under that scope.

## Adding an event type

1. Add an entry to `EVENT_CATALOG` in `schema/catalog.ts` with payload, scopes, sensitivity and `summarize`.
2. Add tests for its validation rules.
3. Removing or renaming payload fields is breaking: bump `SCHEMA_VERSION`.

## Status

| | |
| --- | --- |
| Implemented | Schema, validation, hash-chained store, JSONL file/memory sinks, reader, briefing, synthetic fixture. |
| Simulated | All notification transport, emergency dispatch and voice calls (mock operator only). |
| Needs validation | Escalation intervals, detector thresholds and the briefing's suitability for real operators. |
| Not yet built | Detector, scheduler, state machines, voice agent, UI, telephony build guard. Single-process only: no concurrent writers or log rotation. |
