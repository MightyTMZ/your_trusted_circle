# Back-end audit

Code: `src/server/` (Hono on Node). Docs: `docs/backend.md`, `docs/timeline.md`. Tests: `test/server/`, `tests/voice/`, `tests/agent/`. The server has six parts: authentication, session lifecycle and event validation, safety state and deadlines, alert orchestration, data access and retention, and the voice-call routes.

Contents: What the script already measured · Server-owned deadlines · Exactly-once delivery · Authentication and request hardening · Consent and privacy on the server · Voice-call routes · Two state machines · Deployment surface · Tests to run

## What the script already measured

`telephony-deps`, `mock-endpoint`, `secrets` (including what reaches the browser bundle), `layers` (the server must not import UI or the browser domain), `clock`, `api-drift` (routes versus `docs/backend.md`), `env-drift` (variables read versus `.env.example`), `ci`. Open the flagged lines before reporting.

## Server-owned deadlines

The promise: a closed or offline phone cannot stop a missed check-in from alerting the host, because deadlines live in the database and a scheduler notices them.

- Read `src/server/safety/scheduler.ts` (`runSchedulerPass`) and `main.ts` (the one-second loop that never overlaps itself). A pass that throws must not stop the loop; check the `try/finally`.
- Missed check-ins open an incident dated at the deadline, not at the time the scheduler noticed; the host's own incident goes to their backup contacts.
- Missed heartbeats mark a device offline and log it, but never cancel or move a deadline.
- Session expiry cancels pending check-ins and leaves open incidents escalating.
- The end-to-end test in `test/server/safety.test.ts` ("closed client…") should be read, not trusted by name: does it really drop the client, advance a fake clock and tick real passes, and assert exactly one alert?
- Restart behaviour: with MongoDB, deadlines survive a restart. With the in-memory store they do not, and the server says so at startup. Is that limit documented where a person running a demo will see it?

## Exactly-once delivery

- `Store` methods `claimStep`, `claimRepeat`, `claimJob`, `acknowledgeIncident`, `resolveIncident`, `insertIncident` (partial unique index on `activeKey`) are compare-and-set. Read the memory and Mongo implementations side by side: a guarantee that holds in `MemoryStore` but not `MongoStore` (or the reverse) is High, because tests mostly run on memory and production runs on Mongo.
- Jobs: unique `dedupeKey`, a lease before sending, retries with backoff that never move the escalation deadline (`src/server/alerts/jobs.ts`, `config.ts`).
- Concurrency: is there a test that runs two scheduler passes at once, or two claims at once? If a store contract test exists, run it against a real MongoDB when one is available (`MONGODB_TEST_URI`); if not, say the Mongo path is unproven.
- Indexes in `src/server/store/mongo.ts`: are the unique ones created at startup and tolerant of existing data? Startup code that drops indexes or validators (check `git log -p -- src/server/store/mongo.ts`) deserves a read.

## Authentication and request hardening

`src/server/app.ts` and `src/server/auth/`:

- **Cookies**: `httpOnly`, `SameSite=Lax`, `secure` outside local development; the database stores only a hash of the token; session expiry enforced and expired rows deleted.
- **CSRF**: every state-changing request checks `Origin`; the one exception (Apple's cross-site callback) is protected by OAuth state. Read the allow-list logic, especially the test sign-in extension.
- **OAuth**: state and PKCE verifier in a short-lived cookie; return path restricted to same-app paths (`safeReturnTo`); provider errors never echoed to the browser; accounts keyed by provider and subject, never merged by email.
- **Test sign-in**: on only when `TEST_SIGN_IN=true`, `NODE_ENV` is not production, and both origins are local. Read `loadConfig` and the route: can a misconfigured production deploy turn it on? It must refuse non-local `Host` headers.
- **Input**: JSON only; schemas validated with the project validator; body-size limits on every route that takes a body (the call routes set explicit limits; check ingest and avatar uploads).
- **Rate limiting**: `docs/backend.md` lists it as not built. Confirm and report; note which routes spend money or open resources (`POST /api/calls`, sign-in, join-code guessing, ingest).
- **Authorization**: for each route, who may call it? Sample the sensitive ones (resolve, incident read, timeline, export, session invite, rules) and look for an id the caller could change to read someone else's data (an object-level check, not just "signed in").
- **Headers and CORS**: `secureHeaders`, CORS limited to the app origin with credentials.
- **Static serving**: production serves the Vite build from `dist/`. The same folder receives the compiled server and tests (`tsc -p tsconfig.node.json` writes `dist/src`, `dist/test`, with source maps). Build, then list `dist/` and request `/src/server/main.js` from a running server. If it is served, that is High: it exposes the code and any literals in it.
- **Errors**: `onError` returns a generic message and logs only the error name and message; check nothing logs request bodies, tokens or coordinates.

## Consent and privacy on the server

- **Own consent only**: `PATCH …/me/consent` edits the caller's entry; the host cannot edit another's monitoring or sharing. `test/server/sessions.test.ts` has the test; read it.
- **Location**: `lifecycle/events.ts` drops `location.reported` unless the server itself has an active incident for that person (client-supplied "incident" flags do not count) and strips location-like keys from free-form data at any depth; `lifecycle/relay.ts` keeps live positions in memory only, applies consent on every read, labels `live`/`stale`/gone, and clears on leave, sharing off, session end, expiry and account deletion. Confirm with `test/server/relay.test.ts` and `events.test.ts`, and by grepping the store layer for anything that writes a position.
- **Timeline and briefing**: `data/timeline.ts` and `src/timeline/consent.ts` return only what the caller may see; the voice agent's briefing is consent-filtered.
- **Account data**: `data/account.ts` export includes everything about the person; deletion removes sessions memberships, traces, jobs and incidents or anonymises them, and ends sign-ins. Read for fields missed (avatar, backup contacts, raw recordings).
- **Retention**: `data/retention.ts` and `retentionDays`; a deleted or expired person leaves nothing behind that could be re-identified.
- **No IP logging; no provider tokens stored**: grep for `x-forwarded-for`, `ip`, `access_token`, `refresh_token`.

## Voice-call routes

`src/server/voice/routes.ts`, `calls.ts`, `elevenlabs.ts`, and the agent in `src/agent/`:

- Routes need no sign-in and use only synthetic data, but each call spends model and speech quota. Report as a Medium or High cost/abuse risk depending on whether the deployment is public, and name the fix (sign-in or a shared secret).
- Each call gets its own copy of the synthetic incident; there is a cap on live calls (`maxCalls`); the oldest idle call is dropped.
- Speech: audio is synthesised only from an agent turn already in the timeline; no route speaks arbitrary text. Read `GET …/turns/:n/audio`.
- Request limits: body size, audio size, turn length; operator text length is capped in the agent.
- Keys are read from the environment on the server only; never returned in `capabilities`; never logged.
- Failure paths: model timeout, judge failure, speech failure; each is logged to the timeline and the agent fails closed.
- Nothing here can place a real call: the operator is the person at the console.

## Two state machines

The browser keeps a full session/incident state machine (`src/domain/`) and the server has its own. They must agree wherever a person can see both. Compare:

- default windows (check-in, host acknowledgment, backup acknowledgment) and the allowed ranges in the host setup form versus `rulesPatchSchema` on the server. A value the form allows and the server refuses is a real bug.
- escalation order and recipients; what acknowledge and resolve do; repeat semantics; what happens when the host triggers their own alert.
- how a server-owned incident is shown on a device (`src/domain/serverAlerts.ts`): the local scheduler must never escalate it; acknowledge, resolve and cancel go to the server and its answer replaces the copy.
- what a sessionless (local-only) device does for safety actions.

Report drift with a concrete example of two different outcomes, and say which side should win (CLAUDE.md and `docs/backend.md` say the server owns deadlines).

## Deployment surface

- Which hosting targets exist (Railway-style single process, a serverless adapter, previews)? Each has its own risks: the in-memory relay and rate limits do not survive more than one instance; serverless cannot run the one-second scheduler.
- `.env.example` lists every variable; none has a real value; `.gitignore` covers `.env*`.
- Is there CI running typecheck, tests and the build guard? Is there a health route, and do deploys check it?
- Dependencies: `npm audit --omit=dev` for production; note dev-only findings separately and do not inflate them.

## Tests to run

```bash
npx tsc -p tsconfig.node.json
node --test --test-reporter=spec "dist/test/server/*.test.js"
npx vitest run tests/voice tests/agent tests/safety-guard.test.ts tests/copy-guard.test.ts --reporter=dot
```

Report which suites ran and which could not (no MongoDB, no model keys). For the Mongo path, `mongodb-memory-server` can supply a throwaway database if installed (`npm install --no-save mongodb-memory-server`); it downloads a MongoDB binary the first time, so ask before doing that and say so in the report.
