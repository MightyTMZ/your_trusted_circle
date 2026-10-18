# YTC backend API

Box 2 of [`YTC Grand Architecture.png`](./YTC%20Grand%20Architecture.png), redrawn by responsibility:

![YTC Backend API responsibilities](./backend-api.svg)

Code: [`src/server/`](../src/server/). Tests: [`test/server/`](../test/server/).

| # | Responsibility | Folder |
| --- | --- | --- |
| 1 | Authentication and session authorization | `auth/` (`authz.ts` holds the participant rules) |
| 2 | Session lifecycle and event validation | `lifecycle/` |
| 3 | Safety state and deadlines | `safety/` |
| 4 | Alert orchestration | `alerts/` |
| 5 | Data access and retention | `data/` |
| 6 | Simulated voice-agent escalation (the agent itself is `src/agent/`) | `voice/` |

## Run it

```bash
cp .env.example .env      # fill in at least one sign-in provider
npm run server            # API on :8787, scheduler every second
npm run dev               # web app; /api is proxied to the API
```

Without `MONGODB_URI` the API uses an in-memory store and loses everything on restart.

## Endpoints

All bodies are JSON. Every request except sign-in needs the `ytc_session` cookie. Every write must come from `APP_ORIGIN`.

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/auth/providers` | anyone | Configured sign-in providers |
| `GET /api/auth/:provider/start?returnTo=/path` | anyone | Redirect to Google, GitHub, Apple or Microsoft |
| `GET\|POST /api/auth/:provider/callback` | provider | Signs in; creates the account on first sign-in |
| `POST /api/auth/test/signin` | anyone on this computer | Development only: signs in as a made-up name, no password. Off unless `TEST_SIGN_IN=true`, the app and API origins are localhost, and `NODE_ENV` is not `production`; also refuses requests not addressed to localhost. `localhost` and `127.0.0.1` keep separate cookies, so they act as two phones. |
| `POST /api/auth/logout` | signed in | Ends this browser's sign-in |
| `POST /api/sessions` | signed in | Create a session; you are its host |
| `GET /api/sessions/join/:code` | signed in | Preview before joining |
| `POST /api/sessions/join` | signed in | Join with a code (typed or from the QR link `#join=CODE`). Optional `responderNote`; it reaches responders only if `consent.shareNoteWithResponders` is on |
| `GET /api/sessions/:id` | member | Session as you may see it |
| `GET /api/sessions/:id/invite` | host | Code, join link, QR as SVG |
| `PATCH /api/sessions/:id/rules` | host | Check-in, acknowledgment and heartbeat windows; size; location on/off |
| `PATCH /api/sessions/:id/me/consent` | member | Your own sharing |
| `POST /api/sessions/:id/leave` | participant | Leave |
| `POST /api/sessions/:id/end` | host | End for everyone (not while an alert is open) |
| `POST /api/ingest` | signed in | Store events, logs, actions, sensor and device data |
| `POST /api/sessions/:id/location` | member | Send your latest position for the group map (relayed, not stored) |
| `GET /api/sessions/:id/locations` | member | Positions you are allowed to see, labelled `live` or `stale` |
| `POST /api/sessions/:id/checkins` | member | Your device saw a movement change: start your check-in |
| `POST /api/checkins/:id/respond` | that person | `ok` cancels the deadline; `help` alerts now |
| `POST /api/sessions/:id/help` | member | Ask for help (the app confirms first) |
| `POST /api/sessions/:id/heartbeat` | member | Your device is alive |
| `POST /api/sessions/:id/update` | member | Add "I'm OK" to your open alert (logged only) |
| `GET /api/alerts` | signed in | Alerts delivered to you |
| `POST /api/alerts/:id/acknowledge` | recipient | You are responding; escalation stops |
| `GET /api/incidents/:id` | subject, host, recipients | Incident, deliveries and log |
| `POST /api/incidents/:id/resolve` | responder | After acknowledging: `false_alarm`, `assistance_reached` or `other` |
| `GET /api/sessions/:id/timeline` | member | What you are permitted to see |
| `GET /api/sessions/:id/story` | member | What happened, in sentences, as you may see it: joins and leaves; alerts and their log (host and the person only); movements where a record of positions exists (the live incident demo's person, to whoever they share location with) |
| `GET /api/me` / `PATCH /api/me` | signed in | Profile: `displayName`, and `avatar` (PNG, JPEG or WebP data URL up to 100 KB, or `null` to remove) |
| `GET /api/me/export` | signed in | Everything about you, as JSON |
| `DELETE /api/me` | signed in | `{ "confirm": "DELETE" }` deletes your account and all your data |
| `GET /api/calls/capabilities` | anyone | Which models reason, listen and speak on simulated calls |
| `POST /api/calls` | anyone | Start a practice call to the mock operator about the built-in synthetic incident; returns the opening breakdown |
| `GET /api/calls/incoming` | anyone | Calls the live demo's escalation placed that are still ringing |
| `POST /api/calls/:id/answer` | anyone | Pick up a ringing call; the agent speaks the opening breakdown from that incident's record |
| `POST /api/sessions/:id/demo` | host | Demo mode only. `{ participantId }`: start the live incident demo (see below) |
| `GET /api/sessions/:id/demo` / `DELETE` | host | Demo mode only. Where the demo is; stop it (open alerts stay open) |
| `GET /api/calls/:id` | anyone | Transcript, fact sheet and voice log |
| `POST /api/calls/:id/turns` / `.../speech` | anyone | An operator turn, typed (`text`) or recorded (`audio_base64`, `mime_type`) |
| `POST /api/calls/:id/silence` / `.../interrupt` / `.../end` | anyone | Silence, barge-in, hang up |
| `GET /api/calls/:id/turns/:n/audio` | anyone | Speech (MP3) for an agent turn already in the timeline |

The call routes use only synthetic data and need no sign-in, but each call
spends Gemini and ElevenLabs quota; keep the server on localhost or put
them behind sign-in before exposing it. Details: `docs/timeline.md`, "The
live call".

## Rules worth knowing

- **Deadlines live on the server.** A closed or offline phone cannot stop a missed check-in from alerting the host. The end-to-end test in `test/server/safety.test.ts` proves this, and checks that the host receives exactly one alert and can acknowledge it.
- **Exactly once.**
  - Each step is claimed with a compare-and-set before its alerts are queued.
  - Each job has a unique `dedupeKey`.
  - A worker must claim a job before sending it.
- **Deadlines don't move.** The next step is due a fixed time after the current step was notified. Failed deliveries, retries and missed heartbeats never move that deadline.
- **Acknowledgment stops escalation. It does not confirm wellbeing.** Resolving is a separate step.
- **Location is stored only during an active server incident.** Until then, `location.reported` events are dropped, and location-like keys are removed from free-form data at any depth. Incident events sent by clients do not count; only the server's incidents unlock location.
- **Live group location is relayed, never stored** (decision: option A, see below).

## Live group location

`CLAUDE.md` asks for consent-based group location visibility, while the backend rule is to store no location outside an incident. Both hold because live positions go through a relay (`src/server/lifecycle/relay.ts`) instead of the database.

- **Memory only.** The server keeps each participant's latest fix in memory. It never writes it to MongoDB, the traces collection, logs or the export.
- **Visibility follows consent.**
  - You always see yourself.
  - Everyone sees people who share with `group`.
  - The host also sees people who share with `host`, and people who share with responders during an incident.
  - Consent is checked again on every read.
- **Live, stale, gone.** A fix is shown as `live` for `locationStaleAfterSec` (90 s by default), then as `stale` (last known) until twice that, and after that it's forgotten.
- **Cleared at once** when someone turns sharing off, leaves, deletes their account, when the host ends the session or turns location off for it, and when the session expires.
- **Demo venue ("teleport").** The host may set `rules.demoVenue`, a public place such as a club, through `PATCH /api/sessions/:id/rules`. While it is set, every phone in the session relays a made-up position around it instead of its GPS, sent with `simulated: true` and returned that way to everyone, so it is never shown as a real location. Clearing it (`demoVenue: null`) drops those positions at once. The venue is the host's chosen public place, not anyone's position.
- **The only stored positions** are the person's fixes during an active incident, which are kept for responders and the incident record.
- **Limitation:** the relay lives in one process's memory. Running more than one API instance would need a shared in-memory cache with expiry (for example Redis TTL keys) instead.
- **Accounts are not merged by email**, because that would let an unverified address at one provider take over another account.
- **Nothing sensitive is kept.** No IP addresses, provider access tokens or raw session tokens are stored.

## Live incident demo

A presenter tool for a short demo (`src/server/demo/`). It is mounted only
when `DEMO_INCIDENTS=true`, or with the localhost test sign-in. The host picks
a participant in Demo > Incident demo. That person must have turned on
movement check-ins themself; the demo refuses otherwise.

- **Inputs only.** It writes about 90 minutes of synthetic evening for that
  person (arriving, sitting, a phone left on a table and a check-in answered
  OK, dancing, walking), then, live, a hard impact about 5 s after the
  trigger and stillness. The samples go through the real `SensorPipeline`
  and detectors with 15 s windows.
- **The server does the rest.** When the detector fires, the server opens the
  person's private check-in (their phone shows it). If nobody answers, the
  scheduler opens the incident, alerts the host, then backup contacts, then
  simulated emergency services, exactly as for any other incident. Starting
  the demo sets the session's windows to 20 s (check-in) and 30 s (each
  alert step), unvalidated values chosen to fit a short demo.
- **The call reads this incident.** The demo keeps the incident's timeline in
  memory: the synthetic history, the detections, and a mirror of the
  server's check-in, alerts, acknowledgment and resolution. When escalation
  reaches simulated emergency services, the voice agent places a call that
  rings on the operator console (`#operator`) until someone answers. The
  agent reads only that timeline; an acknowledgment, or the person's own
  "I'm OK" (`incident.participant_update`, stated as self-reported), reaches
  it within a second. The call's `activity` shows the agent's current step
  (reading the record, finding facts, drafting, checking, verifying) while
  it prepares an answer. The incident's log records that the call rang, was
  answered and ended.
- **Consent.** The call names the person and reads their note only if they
  turned on "Share my name and note" (`consent.shareNoteWithResponders`).
  Location is shared with the operator only under `shareLocationWithResponders`.
- **"What happened."** The person's synthetic movements in the demo record
  are told as sentences by `GET /api/sessions/:id/story`, to whoever they
  share location with. No other positions are stored, so nobody else's
  movements can be told.
- **Memory only**, like the location relay. Positions in the demo are
  synthetic, around the session's demo venue. Starting the demo sets the
  venue to Toronto City Hall if none is set, so every phone that shares
  location appears on the map, labelled simulated.

## Not built yet

- Web push. The `Transport` interface is the place to add it; today a user's alert is their in-app inbox entry.
- Accounts for backup contacts, so they can acknowledge. Today their deliveries are simulated and recorded.
- Rate limiting.
- The Python pruning pipeline. The API runs retention hourly until that pipeline exists.
- The OAuth providers are covered by a fake provider in tests. Real sign-in needs registered apps and has not been tried against Google, GitHub, Apple or Microsoft.
