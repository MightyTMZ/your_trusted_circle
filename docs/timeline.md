# Incident timeline and motion pipeline

The timeline is the append-only record of a session. It has two jobs:

1. **Record** what happened (sensor observations, consent, check-ins,
   alerts, escalation, simulated emergency contact, every word on the
   call) so an incident can be reconstructed and analysed later.
2. **Brief the voice agent** during an incident, through a consent-filtered
   view built from it. The agent has no other source of facts.

```
 phone (phyphox export or live samples)
   │  untrusted samples: t, x, y, z (m/s^2)
   ▼
 readPhyphoxExport()                src/sensors/phyphox.ts      CSV + time.csv + device.csv -> absolute samples
   ▼
 MotionStream                       src/sensors/stream.ts       validate, window (60 s, epoch-aligned), bounded memory
   ├─► RawRecorder ─► raw JSONL     src/sensors/raw-recording.ts  every accepted sample, kept separately
   ▼
 windowFeatures()                   src/sensors/features.ts     intensity, stillness, rhythm, impacts, orientation, quality
   ▼
 Timeline.append(sensor.motion_window)                          consent-checked, hash-chained
   ├─► BaselineDetector             src/detector/baseline.ts    personal baseline, stillness-onset anomaly
   └─► PatternDetector              src/detector/patterns.ts    impact→stillness, abrupt stop, orientation change, prolonged stillness
   ▼
 buildOperatorBriefing()            src/timeline/briefing.ts    derived state + 4 h activity history + evidence ──► voice agent
```

`SensorPipeline` (`src/sensors/pipeline.ts`) wires all of this. The scenario
and the tests feed it samples only; every window, baseline, anomaly and
pattern in the examples is the pipeline's own output.

| Example | What it shows |
| --- | --- |
| [`docs/examples/no-response-incident.jsonl`](./examples/no-response-incident.jsonl) | A synthetic 4-hour night out, 272 events: calibration, sitting, a false-alarm check-in answered OK, a backgrounded app, dancing, walking, a sensor-saturating impact, stillness, the phone going offline, escalation to simulated emergency services. |
| [`docs/examples/no-response-briefing.json`](./examples/no-response-briefing.json) | What the agent receives when the mock operator answers. |
| `data/examples/synthetic-raw-accelerometer.jsonl` | The 226 raw batches behind the motion windows (~9 MB, git-ignored). |
| [`examples/accelerometer/`](../examples/accelerometer/) | Real phyphox recordings from a Pixel 9 (`With g`: raw accelerometer, 400 Hz; `Without g`: linear acceleration, 50 Hz). |

Regenerate with `npm run examples`; tests fail if the committed files are stale.

## Input: phyphox exports

| File | Used for |
| --- | --- |
| `Raw Data.csv` | `Time (s)` and `Acceleration x/y/z (m/s^2)`, or `Linear Acceleration x/y/z` for gravity-removed exports. The `Absolute acceleration` column is ignored (it is derived). |
| `meta/time.csv` | START/PAUSE events. `Time (s)` is experiment time; each START maps it to wall-clock time (epoch seconds), segment by segment, since pausing stops the experiment clock. |
| `meta/device.csv` | Sensor name, range (used as the clipping limit), resolution, device model. Optional. |

The reader handles comma, tab and semicolon exports (with decimal commas),
quoted headers, BOM and CRLF. Unusable rows are skipped and reported by line
number. A file without time or axis columns, or without a START event, is
refused with a `PhyphoxFormatError`, because its samples cannot be anchored.

On the real `With g` recording (10 s windows) the pipeline finds vigorous
shaking with irregular rhythm, a ~106° rotation, a **213 m/s² impact at
23:31:52.617Z flagged as sensor-saturated**, then steadier moderate
movement. Nothing is reported as stillness, because the phone never was still.

## Robustness

| Threat | Handling |
| --- | --- |
| Malformed, non-numeric, NaN or Infinity values | Rejected, counted as `malformed` / `non_finite` |
| Physically implausible readings (> ~40 g) | Rejected as `implausible` |
| A bogus far-future timestamp | Rejected as `future`; it cannot fast-forward the stream and close every window |
| Out-of-order samples | Accepted within `lateToleranceMs` (2 s), sorted |
| Samples for an already closed window | Rejected as `late`, never reopening it |
| Duplicate timestamps | Removed and counted |
| A device flooding samples | Capped per window (`over_capacity`) |
| Dropouts and gaps | `coverage_ratio`, `max_gap_ms`; the pipeline logs `sensor.stream_interrupted` / `stream_resumed` |
| Sensor saturation | `clipped_sample_count`; impacts carry `clipped: true` ("true peak higher") |
| Long sessions | At most two open windows; detectors keep bounded state; history is compressed. Tested over 4 h at 50 Hz (720k samples) in under a second. |
| Missing consent | The window is discarded before anything, raw or derived, is written |

Rejection counts appear on each window as `rejected_sample_count`, so data
loss is visible in the record rather than silent.

## Two stores

A 400 Hz accelerometer produces 1.4 million samples an hour. Putting them
in the timeline would bury the events responders need, and CLAUDE.md
requires raw recordings to be kept apart from derived features.

| Store | Holds | Read by |
| --- | --- | --- |
| Raw recording (JSONL batches) | Every accepted sample, columnar `[offset_ms, x, y, z]` | Later analysis, recomputing features, improving the detector |
| Timeline (JSONL events) | One `sensor.motion_window` per window + every other event | Incident Card, briefing, audit |

Each window's `provenance.raw_ref` (e.g. `rec_0001#224`) names its raw
batch. A test recomputes every window from its batch and requires an exact
match.

**Velocity** comes from location fixes (`speed_m_s`, `heading_deg`), not the
accelerometer: integrating acceleration drifts within seconds.

## What a motion window tells you

The window that contains the impact in the example (trimmed):

```json
{"seq":247,"type":"sensor.motion_window",
 "summary":"Motion 23:50:00–23:51:00 for participant par_0002: moderate; movement 1.429 ± 4.662 m/s^2, peak 153.61; still 8% (longest 1.76 s); rhythm 1.818 Hz (regularity 0.083); 1 impact(s), strongest 153.61 m/s^2 at 23:50:57.966Z (sensor saturated; true peak higher); rotated 2°; data covers 100% of the window.",
 "provenance":{"raw_ref":"rec_0001#224","producer":"ypc-motion@0.2.0", …},
 "data":{"sample_count":1499,"rejected_sample_count":0,"effective_rate_hz":24.9996,"coverage_ratio":1,"max_gap_ms":75,
         "clipped_sample_count":1,"dynamic_mean_m_s2":1.4293,"dynamic_std_m_s2":4.6623,"dynamic_peak_m_s2":153.6101,
         "stillness_ratio":0.0794,"longest_still_ms":1760,"cadence_hz":1.8182,"rhythm_regularity":0.0827,
         "impact_count":1,"impacts":[{"at":"2026-10-17T23:50:57.966Z","peak_m_s2":153.6101,"clipped":true}],
         "gravity_vector_m_s2":[0.0075,9.4178,2.7007],"tilt_change_deg":1.646,"activity_level":"moderate"}}
```

| Field | Question it answers | How |
| --- | --- | --- |
| `dynamic_mean/std/peak_m_s2` | How much, how variably, how sharply was the person moving? | \|a\| minus gravity (\|a\| for linear acceleration), Welford mean/variance |
| `stillness_ratio`, `longest_still_ms` | How much of the window was motionless, and the longest stretch? | Samples below the still threshold; run length |
| `cadence_hz`, `rhythm_regularity` | Walking (~1.8 Hz), dancing (~2.3 Hz), or no rhythm? How steady (0–1)? | Autocorrelation of the signed signal on a uniform 20 Hz grid (jitter- and gap-tolerant); the first strong *local* peak, so random movement reports none and multiples of the period are not mistaken for it |
| `impacts[]`, `impact_count` | Was there a jolt, exactly when, and did it saturate the sensor? | Spikes above ~2.5 g merged within 250 ms; clipping against the sensor's range |
| `gravity_vector_m_s2`, `tilt_change_deg` | Which way was the phone facing; did it flip (pocket → flat)? | Mean vector; angle to the previous window. Null for gravity-removed sensors |
| `coverage_ratio`, `max_gap_ms`, `effective_rate_hz`, `rejected_sample_count` | Can these numbers be trusted? | Time-based coverage, observed rate, input rejections |
| `activity_level` | One word: still / light / moderate / vigorous | Thresholds recorded once in `sensor.stream_started` |

All thresholds are unvalidated prototype settings. They are stored once per
stream in `sensor.stream_started`, so every window can be interpreted later.

## Detection

**Baseline** (`BaselineDetector`): the first 10 good-coverage windows set the
person's normal movement (mean and spread of movement, peak, stillness and
cadence), with a spread floor so a very steady calibration cannot inflate
z-scores.

**Anomaly `stillness-onset-z`**: a well-covered, still window whose movement
is ≥ 3 standard deviations below baseline, and only at the *onset* of
stillness, with a 15 min refractory period. A phone left on a table trips it
(the 21:01 check-in in the example). That's acceptable because the check-in is
private and costs one tap.

**Patterns** (`PatternDetector`):

| Pattern | Rule | Why |
| --- | --- | --- |
| `impact_then_stillness` | An impact, then a still window within 2 min | A hard jolt followed by no movement is the clearest reason to check in |
| `abrupt_stop` | Moderate/vigorous window directly followed by a still one | Activity that stops at once, rather than winding down |
| `orientation_change_with_stillness` | Still window rotated ≥ 60° from the previous | The phone changed position and stayed there |
| `prolonged_stillness` | Continuous still run ≥ 20 min, reported once per run | Long inactivity without any single trigger |

Poor coverage or a gap between windows ends a still run: missing data is
never counted as stillness.

## Timeline line format

| Field | Why it exists |
| --- | --- |
| `seq`, `event_id` | Gap-free order; stable IDs to cite. |
| `occurred_at` / `recorded_at` | When it happened vs. when it was logged. |
| `type`, `category` | What kind of event; `category` for quick filtering. |
| `session_id`, `incident_id`, `participant_id` | Scope. `participant_id` is who the event is *about*. |
| `summary` | Deterministic sentence rendered from `data`; can never say more than the data. |
| `actor` | Who or what caused it (enforces "only the participant can consent"). |
| `provenance` | Component, live/recorded/synthetic, simulated, raw source, producer version. |
| `caused_by` | The causal chain (window → pattern → check-in → missed → incident). |
| `data` | Type-specific payload; units in field names or an explicit `unit`. |
| `prev_hash`, `hash` | sha256 chain: an edited, removed or reordered line fails verification. Tamper-evident, not signed. |

## Every event type

Sensitivity `location`/`profile`: shown to responders only under
`location.responders`/`profile.responders` consent. "Needs" means the event is
refused unless the participant currently holds that consent.

### Session

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `session.created` | The escalation policy in force, so timing can be checked against it. | `expires_at`, `checkin_response_window_ms`, `escalation_steps[]` |
| `session.participant_joined` | Who was in the session and how they joined. | `role`, `joined_via` |
| `session.participant_left` | Leaving withdraws all consent; later sensor data is refused. | `reason` |
| `session.expired` | Sessions end automatically. | `expires_at` |
| `session.ended` | Ended early. | `reason` |

### Consent and user-provided data

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `consent.granted` | Self-only. Gates recording and disclosure. | `scopes[]`, `consent_text_version` |
| `consent.revoked` | Stops recording under that scope; withdraws earlier data from briefings. | `scopes[]` |
| `profile.shared` | Self-reported details a responder might need. Sensitivity `profile`. | `display_name`, `pronouns`, `preferred_language`, `emergency_notes` |

### Location

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `location.reported` | Where the device was and whether it was moving. Always last-known. Sensitivity `location`. Needs a location scope. | `latitude`, `longitude`, `accuracy_m`, `fix_at`, `speed_m_s`, `heading_deg`, `place_label` |

### Sensors and detection

All need `monitoring`.

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `sensor.stream_started` | The sensor and every threshold, recorded once. | `sensor`, `gravity_included`, `device_model`, `sensor_range_m_s2`, `window_ms`, `features{…}`, `detector{…}` |
| `sensor.motion_window` | Continuous movement record (see above). | see table above |
| `sensor.baseline_calibrated` | What is normal *for this person*; `caused_by` lists the windows used. | `features[] {name, unit, mean, std_dev, window_count}` |
| `sensor.motion_anomaly_observed` | Movement far below the baseline at the onset of stillness. An observation, not a diagnosis. | `observed_value`, `baseline_mean`, `z_score`, `rule` |
| `sensor.motion_pattern_observed` | A sequence across windows worth a check-in. | `pattern`, `observed_from/to`, `impact_*`, `still_duration_ms`, `preceding_activity`, `tilt_change_deg` |
| `sensor.stream_interrupted` | Samples stopped arriving: separates "no movement" from "no data". | `last_sample_at`, `reason` |
| `sensor.stream_resumed` | Samples came back; the gap bounds what is unknown. | `gap_ms` |

### Connectivity

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `connectivity.device_offline` | The phone stopped reaching the server. Timers keep running. | `last_seen_at`, `detected_by` |
| `connectivity.device_online` | It came back. | `offline_duration_ms` |

### Check-ins

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `checkin.prompted` | The private "are you OK?" before anyone else is told. | `checkin_id`, `trigger` (`motion_anomaly`, `motion_pattern`, …), `response_deadline_at` |
| `checkin.responded` | The answer; `duress` silently asks for help. | `response`, `method`, `latency_ms` |
| `checkin.missed` | No answer by the deadline. | `checkin_id`, `response_deadline_at` |

### Incidents

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `incident.opened` | Starts escalation; names the triggering event. | `trigger`, `trigger_event_id` |
| `incident.acknowledged` | A responder has the alert. Does **not** mean the person is safe. | `acknowledged_by_role`, `acknowledged_by_id`, `notification_id` |
| `incident.resolved` | Closed; separate from acknowledgment. | `resolution`, `resolved_by_role`, `resolved_by_id` |
| `incident.participant_update` | The person added "I'm OK" from their own phone. Self-reported; never acknowledges or resolves. | `update`, `method` |

### Notifications (simulated transport)

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `notification.sent` | Who was told what. Recipients may act only on `delivered_fact_event_ids`. | `notification_id`, `recipient_role`, `attempt`, `is_repeat`, `delivered_fact_event_ids[]` |
| `notification.delivered` | It reached the device. | `notification_id`, `recipient_id` |
| `notification.viewed` | Opened but not acknowledged. | `notification_id`, `recipient_id` |
| `notification.delivery_failed` | It did not arrive; the deadline still applies. | `reason`, `will_retry` |

### Escalation

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `escalation.step_scheduled` | The deadline, anchored by `deadline_basis_event_id` so repeats cannot push it back. | `step`, `target_role`, `due_at` |
| `escalation.step_fired` | Deadline passed unacknowledged. | `step`, `scheduled_due_at`, `fired_late_ms` |
| `escalation.step_cancelled` | Stopped by acknowledgment, resolution or session end. | `step`, `reason` |

### Simulated emergency services and voice

Must be `simulated: true`; the only endpoint is `mock-operator-local`.

| Type | Why it exists | Key fields |
| --- | --- | --- |
| `emergency.simulated_dispatch_requested` | Final step, simulated. | `mock_endpoint_id`, `delivered_fact_event_ids[]` |
| `voice.call_started` | The mock call began. | `call_id`, `mock_endpoint_id` |
| `voice.utterance` | Every turn, both directions; agent turns cite `grounding_event_ids`. | `turn_index`, `speaker`, `text`, `grounding_event_ids[]` |
| `voice.silence_detected` | Silence on the line. | `duration_ms` |
| `voice.agent_interrupted` | The operator spoke over the agent; playback of that agent turn stopped early, so the operator heard only part of it. | `turn_index` (agent turn cut off), `heard_ms` |
| `voice.draft_rejected` | A model-written reply failed a grounding check and was never spoken; the audit trail for "the agent does not make things up". | `turn_index` (operator turn answered), `attempt`, `stage` (`schema`/`guard`/`judge`/`judge_unavailable`/`superseded`), `reasons[]`, `draft_text` |
| `voice.agent_error` | The agent failed mid-call. | `error_code`, `recoverable` |
| `voice.call_ended` | How and when the call ended. | `reason`, `duration_ms` |

## The briefing

`buildOperatorBriefing(events, { incidentId, now })` returns derived state,
each part citing a `source_event_id`, plus the IDs of the timeline lines the
agent may read (`evidenceToJsonl`).

| Section | Why the agent needs it |
| --- | --- |
| `incident`, `person`, `location`, `device`, `escalation`, `alerts` | Current state: who has been alerted, where the person was last seen and how fast they were moving, whether the phone is online. |
| `motion.latest_window` | The most recent reading and its age. |
| `motion.observation`, `motion.patterns` | Why the check-in was sent (e.g. impact of 153.6 m/s², saturated, then 60 s still). |
| `motion.history` | The last 4 h compressed into segments with totals, e.g. *vigorous 21:22–22:40, 78 min, 2.2 Hz*. Gaps and the offline tail are `no_data`. One-minute blips merge, but stillness and impacts never do. |
| `unknowns` | What must be said as unknown: condition, current location, stale motion data, a saturated impact's true strength, an unanswered check-in (the latest one, not an earlier false alarm). |
| `evidence` | Permitted lines and redactions (consent applied as of now; other participants never appear). |

## The voice agent

`OperatorCallAgent` (`src/agent/`) talks to the mock operator from the
briefing. No path in it can place a call. Each operator turn:

```
 operator text (sanitized, JSON-quoted, never in the system prompt)
   ▼
 buildOperatorBriefing(now) ─► buildFactSheet()        facts.ts      pre-worded facts F1..Fn, each citing events
   ▼
 FactRetriever                                         retrieval.ts  BM25 + Gemini embeddings, reciprocal rank fusion
   ▼
 reasoning model ─► { intent, sentences[{text, fact_ids}] }   gemini.ts   gemini-4-argon → gemini-3.8-flash, low thinking
   ▼
 parseDraft ─► checkDraft ─► judgeSentences            guard.ts, judge.ts
   │ pass                              │ fail
   ▼                                   ▼
 voice.utterance                  voice.draft_rejected, one repair attempt, then
 (grounding_event_ids)            the fallback: the most relevant facts, verbatim
```

| Layer | What it stops |
| --- | --- |
| Fact sheet | The model never sees raw data it would have to phrase itself. Every number, time, name and place it may say was written by code from a cited event; unknowns (condition, current location, contact details, description) are facts too. |
| Full sheet in every prompt | Retrieval decides focus only, so a retrieval miss cannot hide a fact. Google Search grounding and all other tools are off. |
| Guard (deterministic) | Numbers, times, number words, names and places not in the *cited* facts; details borrowed from a fact the sentence does not cite ("near the bar" citing a later fix); condition, cause, safety, current-location, companion, clothing and direction terms (`unconscious`, `drugged`, `fell`, `safe`, `still at`, `boyfriend`…) not in the cited facts; claims built only on unknown facts that drop the uncertainty ("they are breathing"); gendered pronouns the participant did not share; internal IDs, URIs, emails, phone-like digits; uncited sentences. `tests/agent/redteam.test.ts` pins what it catches, what it must not reject, and what only the judge can catch (details that appear nowhere on the sheet). |
| Judge (second model call) | Sentences the cited facts do not fully entail (e.g. "they are breathing" citing the fact that breathing is unknown). Partial support fails; a missing verdict fails; a judge outage fails closed. |
| Fallback | If no draft passes, or the model times out or errors, the agent speaks fact text verbatim, or the scope fact for out-of-scope requests. |
| Timeline | Every spoken line cites events that exist; every rejected draft and model error is logged. |

`npm run agent:demo` continues the example call (`--offline` for the
deterministic path, `--interactive` to play the operator). It reads
`GEMINI_API_KEY` from the environment or `.env`.

### The live call (operator console)

The agent runs on the YTC backend server, in the same process as the rest
of the API (`src/server/voice/`, mounted at `/api/calls`; see
`docs/backend.md`), so it reads and appends to the incident timeline
directly. The backend's Origin check and JSON-only rule apply, so a
recording travels as base64 JSON. `npm run dev:full` starts the backend
and the UI; open `http://localhost:5173/#operator` and play the operator.

```
 browser (operator console)              YTC backend (npm run server)
 hold Space or the mic ──base64──► POST /api/calls/:id/speech ─► ElevenLabs scribe_v2 (speech-to-text)
 internal/test text ─────────────► POST /api/calls/:id/turns  ─► OperatorCallAgent.respond() (pipeline above)
 ◄── reply JSON (text, cited facts, rejected drafts, latency)
 <audio> ◄──────────────── GET /api/calls/:id/turns/:n/audio ─► ElevenLabs eleven_flash_v2_5 (streamed)
```

- A practice call restores a fresh copy of the synthetic no-response
  incident onto a clock that follows real time ("about 13 minutes ago"
  keeps counting). A call placed by the live incident demo
  (`docs/backend.md`, "Live incident demo") instead reads that incident's
  own timeline, and rings until the operator answers (`GET
  /api/calls/incoming`, `POST /api/calls/:id/answer`). Either way the agent
  opens with a full breakdown read verbatim from the facts: who, why the
  alert opened, the impact, the last-known location, their note, and that
  nobody has acknowledged it. No model is involved.
- Speech never changes the pipeline. Operator audio is transcribed, then
  handled exactly like an internal text turn. The console has no text
  composer: holding Space or the microphone button records, and release sends
  the turn. Audio is made only from the text of an agent turn already logged
  in the timeline; no route speaks arbitrary text. `forSpeech` changes
  pronunciation only (`m/s²`, minus signs, `UTC`).
- Only ElevenLabs' speech-to-text and text-to-speech endpoints are used,
  never its Agents platform, which can connect to phone networks.
- Holding the talk button while the agent speaks stops playback and logs
  `voice.agent_interrupted` with how much was heard; the next prompt marks
  that turn as cut off. 60 s of silence gets one prompt, then the agent
  ends the call (the alert stays unresolved). Keys stay in the server
  process; the browser only sees `/api`.

## Adding an event type

1. Add an entry to `EVENT_CATALOG` in `src/timeline/schema/catalog.ts`.
2. Add it to the tables above (a test fails if any type is undocumented).
3. Removing or renaming fields is breaking: bump `SCHEMA_VERSION`.

## Status

| | |
| --- | --- |
| Implemented | phyphox adapter, streaming windowing, window features, raw store, baseline and pattern detectors, sensor pipeline, timeline with consent enforcement, briefing with activity history, voice-agent reasoning pipeline (fact sheet, retrieval, guard, judge, fallback), backend server with the simulated-call routes, ElevenLabs speech in and out, operator console. |
| Recorded vs. synthetic | `examples/accelerometer/` holds real Pixel 9 recordings; everything in `docs/examples/` is synthetic. |
| Simulated | Notification transport, emergency dispatch, voice calls (mock operator only: the person at the operator console, in a browser, over localhost), the live incident demo's sensor input. |
| Needs validation | Every threshold and rule; cadence and impact detection on real night-out data; the briefing's usefulness to real operators; the guard's and judge's false-accept and false-reject rates on a labelled set of drafts; answer latency with the chosen models. |
| Not built | Live in-browser sensor capture, gyroscope fusion, the scheduler and state machines in the fixture (escalation is scripted in the scenario), a timeline for server incidents outside the live demo (only the demo keeps one, so only demo incidents get a call), streaming speech recognition. Single process; the hash chain is tamper-evident, not signed. |
