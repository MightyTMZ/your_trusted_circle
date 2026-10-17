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
| `POST /api/auth/logout` | signed in | Ends this browser's sign-in |
| `POST /api/sessions` | signed in | Create a session; you are its host |
| `GET /api/sessions/join/:code` | signed in | Preview before joining |
| `POST /api/sessions/join` | signed in | Join with a code (typed or from the QR link `#join=CODE`) |
| `GET /api/sessions/:id` | member | Session as you may see it |
| `GET /api/sessions/:id/invite` | host | Code, join link, QR as SVG |
| `PATCH /api/sessions/:id/rules` | host | Check-in, acknowledgment and heartbeat windows; size; location on/off |
| `PATCH /api/sessions/:id/me/consent` | member | Your own sharing |
| `POST /api/sessions/:id/leave` | participant | Leave |
| `POST /api/sessions/:id/end` | host | End for everyone (not while an alert is open) |
| `POST /api/ingest` | signed in | Store events, logs, actions, sensor and device data |
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
| `GET /api/me` / `PATCH /api/me` | signed in | Profile |
| `GET /api/me/export` | signed in | Everything about you, as JSON |
| `DELETE /api/me` | signed in | `{ "confirm": "DELETE" }` deletes your account and all your data |

## Rules worth knowing

- **Deadlines live on the server.** A closed or offline phone cannot stop a missed check-in from alerting the host. The end-to-end test in `test/server/safety.test.ts` proves this, and checks that the host receives exactly one alert and can acknowledge it.
- **Exactly once.**
  - Each step is claimed with a compare-and-set before its alerts are queued.
  - Each job has a unique `dedupeKey`.
  - A worker must claim a job before sending it.
- **Deadlines don't move.** The next step is due a fixed time after the current step was notified. Failed deliveries, retries and missed heartbeats never move that deadline.
- **Acknowledgment stops escalation. It does not confirm wellbeing.** Resolving is a separate step.
- **Location is stored only during an active server incident.** Until then, `location.reported` events are dropped, and location-like keys are removed from free-form data at any depth. Incident events sent by clients do not count; only the server's incidents unlock location.
- **Accounts are not merged by email**, because that would let an unverified address at one provider take over another account.
- **Nothing sensitive is kept.** No IP addresses, provider access tokens or raw session tokens are stored.

## Not built yet

- Web push. The `Transport` interface is the place to add it; today a user's alert is their in-app inbox entry.
- Accounts for backup contacts, so they can acknowledge. Today their deliveries are simulated and recorded.
- Rate limiting.
- The Python pruning pipeline. The API runs retention hourly until that pipeline exists.
- The OAuth providers are covered by a fake provider in tests. Real sign-in needs registered apps and has not been tried against Google, GitHub, Apple or Microsoft.
