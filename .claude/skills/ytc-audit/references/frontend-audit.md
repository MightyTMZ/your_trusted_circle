# Front-end audit

Source of truth: `docs/ui-guidelines.md` (read it first; it changes) and the tokens in `src/styles.css`. The code wins over the guidelines when they disagree: the guidelines say so themselves, and a disagreement is itself a finding.

Contents: What the script already measured · Design rules · Safety-critical UI · Consent UI · Layout across devices · Accessibility · States · Server assumptions · Looking at it for real

## What the script already measured

Run `scripts/guardrail-check.mjs` first. It covers, on the front end: `ui-tokens` (hard-coded colours/radii/fonts), `ui-contrast` (text tokens against backgrounds in each theme, WCAG ratios), `theme-consistency` (themes named in the docs versus the code), `layers` (UI imports), `clock`, and the UI half of `api-drift` (paths the UI calls that no route serves). Open the flagged lines; some are legitimate (a QR library needs literal colours, a shadow may use black with alpha).

## Design rules (docs/ui-guidelines.md §1)

| Rule | How to check |
|---|---|
| Tokens only | *script*. In `src/styles.css`, colours should sit in `--token` declarations, rules should use `var(--…)` |
| Two layers: content opaque, only floating controls use material | `grep -n "material" src/styles.css src/ui`; any card, row or field using `.material` is a violation |
| One accent, with meaning | Count accent-coloured things on each screen (`on-accent`, `outline-accent`, `--accent`). More than about four on a screen is the guidelines' own limit |
| One focal point per screen | For each file in `src/ui/screens/`, name the hero element (gauge, numeral, map). Two competing heroes is a finding |
| One primary action per screen | Count simultaneously visible `pbtn on-accent` (or `on-danger`) buttons per render state. Steps and sheets reset the count |
| Show less: no reassurance captions; keep only safety-rule captions | Read `t-cap` and `t-sub` strings; captions should be one of: observation-not-diagnosis, acknowledgment-not-safe, simulated-call notices, unvalidated labels |
| Copy rules | `src/ui/copy.ts` wording; sentence case; "Movement changed"; "Simulated" wherever emergency services appear (`tests/copy-guard.test.ts` enforces three of these) |

**Components.** The guidelines list the primitives (`Controls.tsx`, `Gauges.tsx`, `Icon.tsx`, `AppNav.tsx`, `Sheet.tsx`, and the data components). Compare the list in §6 with `ls src/ui/components`. A component that exists but is not documented, or a screen that hand-rolls a button, input or sheet instead of using the primitive, is a Medium finding. Check that new classes in `styles.css` follow existing naming.

**Themes.** Two themes (Mono dark, Onyx light) share one structure. Check: every token defined in `:root` that components use is also defined or deliberately inherited in the Onyx block; no tinted themes (the guidelines retired orange); the picker in Settings previews both; a saved theme that no longer exists falls back to Mono (`loadTheme`).

**Logo and assets.** The logo is a CSS background per theme (`.logo` in `styles.css`, `public/logo-*.png`). Confirm both resolve, have alt semantics (`role="img"` with a label), and the tab icons exist.

## Safety-critical UI

These are the screens where a defect hurts people. Read them closely, not just by grep.

1. **Help is always reachable.** Find how a participant asks for help from every screen: the nav button (`AppNav.tsx`, `HelpSheet.tsx`), and during an open alert the overlay (`AlertOverlay.tsx`, z-index above everything). Confirm no screen, sheet or overlay hides or disables it, including the check-in takeover screen and the settings screen. Confirm "ask for help" is confirm-then-send and that a mis-tap is recoverable.
2. **Check-in screen.** The deadline is visible and counts down (`ParticipantCheckInScreen.tsx`); it names who is alerted if time runs out; both answers are equally easy to reach one-handed. The host never sees someone else's pending check-in.
3. **Alert screens.** Acknowledge is a separate action from resolve; wording never implies the person is safe (copy-guard); the next escalation deadline is visible; the Incident Card opens from the alert.
4. **Cancelling a false alarm** (if present): confirmation names who will see it; the receipt says it is the person's own report; the help button stays available afterwards.
5. **Location freshness.** A stale or missing position must never look live. Read `LocationStamp.tsx`, `GroupMap.tsx`, `location.ts` (`freshness`): "live" requires a recent reading from an online device; stale shows its age; withheld shows why.
6. **Simulation honesty.** Everything involving emergency services or the call carries "Simulated" and says nothing is really contacted (`SimulatedTag.tsx`, `copy.ts`: `simulatedCallBanner`, `prototypeNotice`). Look at the start screen too: is the prototype notice there?
7. **Unvalidated values.** Thresholds and timing steppers say they are unvalidated.

## Consent UI

- Sharing choices are the participant's own, on their own device; the host's screens show other people's choices as read-only ("their choice") and offer no toggle for another person.
- Sharing choices are explained in plain words (who sees what) and default to the least sharing that still lets the app work. Read the defaults in `ParticipantConsentFields.tsx` (`defaultParticipantInput`).
- A person can turn sharing off and leave at any time, and the screen says what that does.
- The active-session indicator is present on every signed-in screen.

## Layout across devices

Static check: `@media` queries in `styles.css`; the nav is a sidebar on tablet and desktop and a tab bar on phones; safe-area insets (`env(safe-area-inset-*)`) for notches; `100dvh` rather than `100vh`; no fixed pixel widths on containers. Then look at real screens (below). Things that go wrong in this app specifically: the floating demo button covering a primary action; the tab bar covering a footer button; sheets taller than a small phone; map-and-list screens producing nested scrolling.

## Accessibility

- Touch targets at least 44×44 px for anything a person taps under stress. Find the small ones: `.ibtn-sm`, `.chip`, `.segment`, steppers. Measure rendered sizes in the browser, not CSS values.
- Contrast: *script* `ui-contrast`. Under 4.5:1 is a finding for body text; check where each flagged token is used (tertiary text on a light background is the common case, and danger-coloured buttons with white text).
- Every input has a label (`htmlFor`/`aria-label`); icon-only buttons have `aria-label`; dialogs (`Sheet.tsx`, `AlertOverlay.tsx`) use `role="dialog"`/`alertdialog`, trap focus and return it on close; countdowns use `role="timer"` and live regions are polite, not noisy.
- Visible focus (`:focus-visible`), and `prefers-reduced-motion` / `prefers-reduced-transparency` are honoured (the stylesheet already has the latter for the alert overlay).
- Colour is never the only signal: alerts have text and an icon, not just red.
- Errors are specific and announced (`role="alert"`).

## States

For each screen that reads from the server (`useServerSession.tsx`, `api.ts`), find what the person sees when it is **loading**, **empty**, **failing** and **offline**. A blank screen, an endless spinner, or a silent failure on a safety action (help, acknowledge, resolve, cancel) is High. Check that failed sends can be retried and that the person is told when something did not send. Polling intervals: not so frequent as to hammer the server, not so slow that an alert appears late.

## Server assumptions (docs/ui-guidelines.md §8a)

"Never let a screen assume a server feature that isn't there." *script* `api-drift` lists UI calls with no matching route. Also read what the UI does when a call returns 4xx/5xx: does it show the server's message, and does the app degrade to local behaviour where the guidelines say it should? Sessions that exist only on the device (no `serverId`) behave differently from server-backed ones; check both paths for safety actions.

## Looking at it for real

Static reading misses layout, overlap and timing bugs. If a browser tool is available:

1. Start the app: `npm run dev:full` (API plus Vite) with `TEST_SIGN_IN=true` in the environment for password-free sign-in with made-up names. `localhost:5173` and `127.0.0.1:5173` keep separate cookies, so they act as two phones (host and participant). Use synthetic names only.
2. Walk: start, sign in, host setup (all four steps), invite, join from the second "phone", home, my sharing, trigger a check-in with the Demo panel, let it miss, open the alert as host, acknowledge, resolve, open the Incident Card, open the simulated call.
3. Repeat at 375, 768 and 1280 px wide, in both themes. Look for horizontal scroll, clipped controls, overlaps with the Demo button, and text under 12 px.
4. Check the keyboard path through the check-in and help flows.
5. Record what you saw with the width and theme. Stop the servers when done.

If no browser is available, say the visual checks were not done; do not infer them.
