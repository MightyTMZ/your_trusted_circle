# YTC UI guidelines

The visual language for every YTC screen, after Apple's Human Interface
Guidelines: opaque grouped content, a translucent material only on the
floating controls, no colour (white or black marks what's active), the system font at Apple's text-style sizes.
Follow this for any UI change so new screens match the rest of the app on
iPhone, iPad and desktop.

The code is the source of truth: tokens and component classes live in
`src/styles.css`, React primitives in `src/ui/components/` (`Controls.tsx`,
`Gauges.tsx`, `Icon.tsx`, `AppNav.tsx`, `Sheet.tsx`), themes in
`src/ui/theme.ts`. The "YTC Front-End Design" canvas (claude.ai artifact
`Niz3emTe6iPUGuoahEMbXF`) predates this system and still shows the older
frosted-glass look; when it and the code disagree, the code wins.

The HIG references below are page names from Apple's Human Interface
Guidelines (`page.md › Heading`).

## 1. Rules that decide most questions

1. **Tokens only.** Every colour, radius, shadow and font comes from a CSS
   custom property. No hex values inside components.
2. **Two layers.** Content (cards, rows, fields, chips) is opaque: `surface`
   or `fill`. Only the functional layer that floats above content (tab bar,
   sidebar, session bar, sheets, map chip, demo button) uses `material`.
   Never put material on a card or row (`materials.md › Liquid Glass`:
   "Don't use Liquid Glass in the content layer").
3. **One accent, with meaning.** The accent means *active, on, in progress,
   primary action or current selection*. Everything else is label colours
   and grey fills. If more than about four things on a screen are
   accent-coloured, remove some (`color.md › Best practices`).
4. **One focal point per screen.** A hero gauge, a hero numeral or a map.
   Everything else supports it and stays quieter.
5. **One primary action per screen.** A single filled accent button.
   Secondary actions are grey-fill buttons, chips or rows (`buttons.md ›
   Style`: "use a button that has a prominent visual style for the most
   likely action").
6. **Show less.** Prefer progressive disclosure (steps, expandable rows,
   help text only on the selected option) over long forms. Don't repeat a
   fact that is already on screen. No reassurance or explainer captions
   ("you can change this anytime", "only you can see these"). Keep a
   caption only when a safety rule requires it: motion is an observation,
   not a diagnosis; acknowledging doesn't confirm wellbeing; simulated
   calls say no real service is contacted.
7. **Copy rules still apply.** Use `src/ui/copy.ts` wording. Motion is only
   "Movement changed"; acknowledgment never implies the person is OK;
   anything involving emergency services says "Simulated". Labels use
   sentence case throughout; keep it consistent.

## 2. Themes

Two themes share one structure: dark and light, both colourless. Only the token values change. A theme is
`data-theme="<id>"` on `<html>` (set by `applyTheme` in `src/ui/theme.ts`,
saved in local storage) that overrides tokens.

| Theme | Base / surface | Accent | Use |
| --- | --- | --- | --- |
| Mono (default) | `#000000` / `#1C1C1E` | `#FFFFFF` white, black label | Dark, no colour; white marks what's active |
| Onyx | `#F2F2F7` / `#FFFFFF` | `#000000` black, white label | Light, no colour; black marks what's active |

Settings → Theme shows them side by side, dark on the left and light on
the right. A saved theme that no longer exists (the retired orange themes,
Ember and Porcelain) falls back to Mono.

**Known HIG deviation.** `dark-mode.md › Best practices` says "Avoid
offering an app-specific appearance setting." We keep the Mono/Onyx
picker on purpose: it is the product's brand choice, not only a light/dark
switch. Every theme must still pass contrast on its own.

Themes change surfaces, not the layout. YTC has no colour accent: don't
add tinted themes (orange, gold, ice blue, purple). Orange was tried and
removed.

Adding a theme: override the same tokens as the existing ones
(backgrounds, fills, material, labels, accent set, switch, track, map),
check every label token against `--bg-base`, `--surface` and `--fill` for
contrast (section 9), and add a preview tile in Settings → Theme. Do not
add themes that change layout, radius or type.

## 3. Tokens

Declared on `:root, .tp` (`.tp` is the theme preview tile; the base block
is Mono). Theme blocks (`[data-theme='…']`) come after the base block and
override tokens on the same element.

| Group | Tokens |
| --- | --- |
| Background | `--bg-base` (grouped page background), `--surface` (cards, grouped lists), `--bg-elevated` (raised inside a card) |
| Fill | `--fill` (control fill: chips, icon buttons, fields inside a card, segmented track), `--fill-strong` |
| Material | `--material` (translucent), `--material-solid` (Reduce Transparency, no backdrop-filter support, demo panel), `--material-blur` = `blur(30px) saturate(150%)`, `--material-shadow` |
| Lines | `--border-hairline` (0.5px separators and material edge), `--border-highlight` (material top edge) |
| Labels | `--text-primary`, `--text-secondary` (≥ 4.5:1 everywhere), `--text-tertiary` (placeholders and decoration only, ≥ 3:1) |
| Icons | `--icon` (default), `--icon-muted` (inactive sidebar icons) |
| Accent | `--accent`, `--accent-ink` (text on accent), `--accent-icon` (icons on accent), `--accent-ring` (focus, selection outline, help ring), `--accent-soft` |
| Switch | `--switch-off`, `--switch-knob`, `--switch-knob-on` (dark in Mono, where the track is white), `--segment-thumb` |
| Data | `--track-inactive`, `--tick-inactive`, `--knob` |
| Map | `--map-bg`, `--map-street`, `--map-block` |
| Misc | `--qr-bg`, `--scrim` |
| Shape | `--r-card` 22px, `--r-tile` 14px, `--r-field` 12px, `--r-pill` 999px; circles are 50% |
| Motion | `--ease` = `cubic-bezier(.25,.1,.25,1)` |
| Type | `--font` = the system font stack (`-apple-system`, `BlinkMacSystemFont`, `system-ui`, then Segoe UI, Roboto, Helvetica Neue) |

No gradients and no glows: fills are flat (`--accent-glow` stays `none`
and exists only for older call sites). The page background is flat
`--bg-base`.

## 4. Typography

The platform's system font: San Francisco on Apple devices, Segoe UI on
Windows, Roboto on Android (`typography.md › Using system fonts`). No web
fonts. Sizes follow Apple's iOS text styles; 17px is the body default and
nothing goes below 11px (`typography.md › Ensuring legibility`).

| Class | Size / weight | Apple style | Use |
| --- | --- | --- | --- |
| `.t-display` | 34 / 700 | Large Title | Welcome headline, "Are you OK?" |
| `.t-title` | 28 / 700 | Title 1 | Screen title (left-aligned headers) |
| `.t-head` | 17 / 600 | Headline | Centered title in back-button headers |
| `.t-hero` | 48 / 600 | — | The one hero numeral |
| `.t-hero-word` | 28 / 700 | — | Hero that is words, not a number ("All alerted"); `Gauges.tsx` applies it |
| `.t-card` | 17 / 600 | Headline | Card titles |
| `.t-name` | 17 / 400 | Body | Row titles, values |
| `.t-body` | 17 / 400 | Body | Body text |
| `.t-lead` | 17 / 400 secondary | Body | Intro paragraph under a title |
| `.t-sub` | 15 / 400 secondary | Subheadline | Row subtitles, metadata |
| `.t-cap` | 13 / 400 secondary | Footnote | Timestamps, footnotes |
| `.lbl` | 13 / 400 secondary | Footnote | Section header above a group, inset 16px to align with row text |

Add `.num` (tabular, lining numerals) to anything showing times, counts or
codes. Hierarchy comes from size, weight and label colour, never extra
colours. At most two weights per card. Tab labels are 11 / 600.

Only use a subtitle line when it carries data (a time, a name, a status).
Don't add explanatory filler under every heading.

## 5. Surfaces

- **Content layer.** `.surface` + `.card`: an opaque card, radius 22,
  padding 16, no border, no shadow. Lists inside a card use `.card-list`
  with `.row` / `.lrow` / `.toggle-row` (0.5px hairline between rows), the
  inset grouped list pattern (`lists-and-tables.md`). Don't nest cards
  inside cards.
- `.fill`: controls and nested items (chips, icon buttons, avatars, fields
  inside a card, the segmented track). `.fill-2` is the stronger fill
  (operator bubbles in the transcript).
- **Functional layer.** `.material`: translucent background, backdrop blur,
  0.5px edge and a soft shadow. Only for the tab bar, sidebar, session bar,
  sheets, the map chip, the theme preview bar and the demo button.
  `prefers-reduced-transparency: reduce` and missing backdrop-filter
  support swap it for `--material-solid`.

Spacing (8pt grid, 4px for fine adjustment): card padding 16; 16 between
related cards; 24 between sections; screen side padding 16 on phone, 32
on tablet and desktop.

## 6. Components

All interactive elements are real `<button>` / `<input>` elements with the
`.btn` base class, which gives: a press state that dims to 60%
(`buttons.md › Best practices`: "Always include a press state"), a
focus-visible 3px accent ring with 2px offset, disabled at 35% with no
pointer events. Minimum hit area 44×44 (`accessibility.md › Mobility`).

| Component | Markup | Notes |
| --- | --- | --- |
| Primary button | `button.btn.pbtn.on-accent` | 50px capsule, full width, flat accent fill, 17/600 label in `--accent-ink`. One per screen. |
| Secondary button | `button.btn.pbtn.fill` | Same shape, grey fill, primary label. |
| Outline accent | `button.btn.pbtn.outline-accent` | Second, urgent choice (e.g. "I need help"): grey fill with a 1.5px accent ring. |
| Icon button | `button.btn.ibtn.fill` | 44px circle (`.ibtn-sm` 40px), 22px icon, `aria-label` required. |
| Chip | `button.btn.chip.fill` | 40px capsule, 15/500. Small secondary actions. |
| Segmented control | `<ChipChoice>` → `.segmented` > `button.segment[role=radio]` | Grey track, the selected segment gets a raised `--segment-thumb`, never the accent (`segmented-controls.md`). |
| Option list | `<OptionList>` → `.opt-list` > `button.btn.opt[role=radio]` | One grouped list; the selected row shows a trailing accent checkmark. Help text only for the selected option. Inside a card the list takes `--fill`. |
| Switch | `button.btn.toggle[role=switch][aria-checked]` > `.knob` | iOS switch: 52×32 track, 28px white knob, accent track when on, 44px hit area via `::before`. No icon or On/Off text; the fill and knob position carry the state. Use inside a list row (`toggles.md › Mobile`). |
| Stepper | `.ibtn.ibtn-sm` − value + | For numeric settings (escalation timing). |
| Quick tile | `button.btn.qtile.fill` | 88px tall, 22px icon over 13px label, equal-width grid of 2–4. |
| Text field | `input.field` / `textarea.field` | 50px, radius 12, `--surface` on the page and `--fill` inside a card, always with a `<label>` (visible `.lbl` or `.sr-only`). |
| Tag | `span.tag` | 24px grey-fill capsule, 12/600. `.tag.on-accent` only for an active alert state. |
| Avatar | `.av` / `<Avatar name src>` | 40px circle, `fill` by default. Profile picture when the account has one, initials otherwise. `.on-accent` only for the person with an open alert. |
| Avatar stack | `.av-stack` > `.av` | 32px solid avatars overlapping 10px, ringed in `--surface`. Leftmost on top: set `z-index` descending left to right. |
| Step progress | `.seg` > `span` | Multi-step flows; done/current segments `.is-on`. |
| Sheet | `<Sheet title onClose>` | Confirmations, portalled to `<body>`. Material bottom sheet on phone, centered dialog on larger screens, blurred scrim, Escape closes. Most likely button on top of the stack (`alerts.md › Buttons`). Destructive confirms use a grey primary, not the accent; irreversible ones (delete account) also need typed confirmation. |
| Tab | `button.btn.tab` > `.slot-ic` + `.slot-label` | Phone tab bar item: icon over an 11px label. Selected: accent icon and label on a grey fill. Badge `.badge` for an unacknowledged alert. |
| Sidebar item | `button.btn.side-item` | Tablet and desktop: icon and 15px label in a 44px row. Selected: grey fill, accent icon. |
| Help button | `button.btn.material.help-fab` (phone), `button.btn.side-help` (sidebar) | "I need help". Never a tab: tabs navigate, help acts (`tab-bars.md › Best practices`). 62px material circle with an accent ring beside the tab bar; a labelled ringed row at the top of the sidebar. |
| Error | `p.error[role=alert]` + `alert` icon | Grey-fill box, primary text. No red. |

React wrappers in `src/ui/components/Controls.tsx`: `Toggle`, `ToggleRow`,
`OptionList`, `ChipChoice`, `Stepper`, `StepBar`, `ScreenHeader`, plus
`initials()` for avatars. Use them instead of re-writing the markup.

### Data components

| Component | Use | Build |
| --- | --- | --- |
| Arc gauge | Countdowns (next escalation, check-in window) | ~200° SVG arc, 8px round stroke, flat accent active stroke, white knob with accent ring, hero numeral + label inside, start/end times at the arc ends. Turns grey with no knob when stopped. Word values use `.t-hero-word` so they stay inside the arc. |
| Tick dial | Elapsed time across a window (incident card) | 48 radial ticks generated in JS. Lit ticks fade in and grow toward the current point; the leading tick is tallest; unlit ticks fade out toward the end. Hero numeral sits inside the arc. |
| Scrubber | Session progress | 4px accent line on grey, white knob with accent ring, elapsed left, remaining right (13px). |

Read-only data components use `role="img"` or `role="timer"` with an
`aria-label` that states the values in words. Never use native `<input
type="range">` or `<progress>` visually.

## 7. Icons

One family: line icons on a 24px grid drawn at 22px (18px in chips and
list chevrons), 1.75px stroke so they match the weight of 17px text
(`icons.md`), round caps and joins, inline SVG with `class="ic"` and
`aria-hidden="true"`. Colour comes from `currentColor` (`--icon` by
default, `--accent-icon` on accent). No emoji, no icon fonts.

## 8. Layout across devices

One set of markup serves every size; CSS does the rest. The sidebar and
the tab bar switch at 768px viewport width. Two-column content uses
`.cols` > `.col`, which splits when `.app-main` is at least 760px wide
(a container query).

| | Phone (< 768px) | Tablet and desktop (≥ 768px) |
| --- | --- | --- |
| Navigation | Floating material tab bar at the bottom, labelled tabs | Floating material sidebar on the left, labelled rows |
| "I need help" | Separate round button left of the tab bar | Ringed row at the top of the sidebar |
| Session home, Alert, Incident card | One column | Two columns (`.cols`) |
| Forms and focused flows | Full width | `.narrow`, centered, max 560px |
| Settings | Gear in the header of Group and Sharing | Last row of the sidebar |
| Sheets | Bottom sheet | Centered dialog |

Nav items (`AppNav.tsx`): Group, Alert (host only, while an alert is
unresolved; also active on Incident card and Call), Sharing, and Settings
in the sidebar only. Help is hidden while an alert about you is open.
Don't add other floating buttons over the content: they cover cards and
crowd the nav. Welcome, Host setup, Join, Sign in, the private check-in
and the recipient inbox have no nav. Keep primary actions in the lower
part of phone screens.

**Known HIG deviation.** `tab-bars.md` says "Don't disable or hide tab bar
buttons". The Alert tab appears only while the host has an unresolved
alert, because an empty Alert section has nothing to show yet. Revisit if
the tab bar starts to feel unstable in testing.

The active-session bar (`ActiveSessionBar`) stays on every in-session
screen as a material bar pinned to the top. It is the visible session
indicator CLAUDE.md requires; don't remove it to save space.

## 8a. Backend features

Screens must not pretend the server exists. Sign-in, account export,
sign out and delete account call the API in `src/ui/api.ts` (see
`docs/backend.md`). Every call tolerates the server being absent: the
screen says the feature needs the server, or falls back to the on-device
equivalent (Download data on this device, Delete data on this device).
Only show sign-in providers the server reports from
`GET /api/auth/providers`. Sign in and sign up are one flow.

Profile pictures are stored by the server (`avatar` on `GET`/`PATCH
/api/me`) as a PNG, JPEG or WebP data URL of at most 100 KB. The app
square-crops and resizes to 256×256 before upload (`toAvatarDataUrl`).
Photo controls appear only when signed in.


## 9. Accessibility

- Body text ≥ 4.5:1, large text, icons and placeholders ≥ 3:1 against
  every surface they sit on, in every theme. Measured values: secondary
  labels are 5.3–6.4:1 on dark surfaces, 5.4–6.0:1 on Onyx;
  accent labels are 21:1 (black on white in Mono, white on black in
  Onyx).
- Headings in order; every control labelled; icon-only buttons have `aria-label`.
- `role="radio"`/`aria-checked` for options and segments, `role="switch"`
  for switches, `aria-current="page"` on the active tab or sidebar item.
- Live values that change (countdowns, steppers, status after an action)
  use `aria-live="polite"` or `role="status"`.
- `prefers-contrast: more` strengthens secondary labels and outlines every
  surface; `prefers-reduced-transparency: reduce` makes the material
  opaque; `prefers-reduced-motion: reduce` turns animation off
  (`accessibility.md`, `materials.md`).

## 10. Motion

200–260ms, ease-out. Cards fade and rise 8px on enter (`.rise`, stagger
40ms with `animation-delay`). Switches slide in 200ms. Buttons dim on
press. No looping or bouncy decoration (`motion.md`).

## 11. Checklist for a UI change

1. Find the closest existing screen and reuse its structure.
2. Build from the components above. If you need a new one, add it to
   this file in the same change.
3. Layers: is anything that isn't a floating control using `material`?
4. Accent count: is everything accent-coloured actually active, on,
   in progress or the primary action?
5. One focal point, one primary action, no repeated facts.
6. Check it at 360, 390 and 430px wide, on tablet and desktop, and in
   both themes, including the light one (Onyx).
7. Text sizes: nothing below 11px; body text 17px.
8. Keyboard: tab order, focus ring visible, every control reachable.
9. Copy matches `src/ui/copy.ts`; simulated things say "Simulated".
