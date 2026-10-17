# YTC UI guidelines

The visual language for every YTC screen: dark frosted glass, one accent
colour, Manrope, round controls. Follow this for any UI change so new screens
match the rest of the app on iPhone, iPad and desktop.

The code is the source of truth: tokens and component classes live in
`src/styles.css`, React primitives in `src/ui/components/` (`Controls.tsx`,
`Gauges.tsx`, `Icon.tsx`, `AppNav.tsx`, `Sheet.tsx`), themes in
`src/ui/theme.ts`. The "YTC Front-End Design" canvas (claude.ai artifact
`Niz3emTe6iPUGuoahEMbXF`) is a mockup of the same system for exploring
ideas; when it and the code disagree, the code wins.

## 1. Rules that decide most questions

1. **Tokens only.** Every colour, radius, shadow and font comes from a CSS
   custom property. No hex values inside components.
2. **One accent, with meaning.** The accent means *active, on, in progress,
   primary action or current selection*. Everything else is white or grey.
   If more than about four things on a screen are accent-coloured, remove some.
3. **One focal point per screen.** A hero gauge, a hero numeral or a map.
   Everything else supports it and stays quieter.
4. **One primary action per screen.** A single accent pill button. Secondary
   actions are glass chips or rows.
5. **Show less.** Prefer progressive disclosure (steps, expandable rows,
   help text only on the selected option) over long forms. Don't repeat a
   fact that is already on screen. No reassurance or explainer captions
   ("you can change this anytime", "only you can see these"). Keep a
   caption only when a safety rule requires it: motion is an observation,
   not a diagnosis; acknowledging doesn't confirm wellbeing; simulated
   calls say no real service is contacted.
6. **Copy rules still apply.** Use `src/ui/copy.ts` wording. Motion is only
   "Movement changed"; acknowledgment never implies the person is OK;
   anything involving emergency services says "Simulated".

## 2. Themes

Four themes share one structure. Only the token values change. A theme is
`data-theme="<id>"` on `<html>` (set by `applyTheme` in `src/ui/theme.ts`,
saved in local storage) that overrides tokens.

| Theme | Base | Accent | Use |
| --- | --- | --- | --- |
| Mono (default) | `#0C0C0D` charcoal | `#F2F2F2` white | Dark, no colour; white marks what's active |
| Onyx | `#F5F5F4` white | `#111111` black | Light, no colour; black marks what's active |
| Ember | `#0B0B0C` charcoal | `#FF6A1F` orange | Dark, orange accent |
| Porcelain | `#ECEAE5` warm light | `#E2601F` orange | Light, orange accent |

Settings → Theme shows them as a 2×2 grid in that order: the colourless
pair (Mono, Onyx) on top, the orange pair (Ember, Porcelain) below, dark
on the left and light on the right.

Themes change surfaces and lighting, not the layout. Don't add themes that
re-tint the whole UI with a new hue (gold, ice blue, purple). They read as
generic and dilute the brand.

Adding a theme: override the same tokens as the existing ones (base, wash,
spots, glass, accent set, `--accent-ink`, `--accent-icon`, track, map),
check every text token against its surfaces for contrast (section 9), and
add a preview tile in Settings → Theme. Do not add themes that change
layout, radius or type.

## 3. Tokens

Declared on `:root, .tp` (`.tp` is the theme preview tile). Theme blocks
(`[data-theme='…']`) come after the base block and override tokens on the
same element. A token that references another token (like `--shadow-card`)
must be re-declared in a theme that changes what it references.

| Group | Tokens |
| --- | --- |
| Background | `--bg-base`, `--bg-elevated`, `--wash` (top light), `--spot-1`, `--spot-2` (soft accent light low on screen) |
| Glass | `--surface-glass`, `--surface-glass-2` (nested, lighter), `--surface-glass-fallback`, `--surface-glass-2-fallback`, `--blur` = `blur(24px) saturate(140%)` |
| Lines | `--border-hairline`, `--border-highlight` (1px inset top edge only) |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary` (decorative only, never body text) |
| Icons | `--icon` (default), `--icon-muted` (inactive nav) |
| Accent | `--accent`, `--accent-light`, `--accent-dark`, `--accent-gradient`, `--accent-ink` (text on accent), `--accent-icon` (icons on accent), `--accent-glow` (active controls only), `--accent-ring`, `--accent-highlight` |
| Data | `--track-inactive`, `--tick-inactive`, `--knob` |
| Map | `--map-bg`, `--map-street`, `--map-block` |
| Misc | `--qr-bg`, `--qr-ink`, `--scrim`, `--shadow-card` |
| Shape | `--r-card` 28px, `--r-tile` 20px, `--r-pill` 999px; circles are 50% |
| Motion | `--ease` = `cubic-bezier(.2,.7,.2,1)` |
| Type | `--font` = Manrope, then Plus Jakarta Sans, then system-ui |

Every screen sits on the ambient backdrop (base + `--wash` at the top +
two faint accent spots low down). Never put glass on a flat background.

## 4. Typography

Manrope 400–800 from Google Fonts. No Inter, Roboto or Arial.

| Class | Size / weight | Use |
| --- | --- | --- |
| `.t-display` | 30 / 700 | Welcome headline, "Are you OK?" |
| `.t-title` | 20 / 700 | Screen title (left-aligned headers) |
| `.t-head` | 17 / 600 | Centered title in back-button headers |
| `.t-hero` | 44 / 700 | The one hero numeral |
| `.t-card` | 15 / 600 | Card titles |
| `.t-name` | 14 / 600 | Row titles, values |
| `.t-body` | 14 / 500 | Body text |
| `.t-lead` | 15 / 500 secondary | Intro paragraph under a title |
| `.t-sub` | 12 / 500 secondary | Card subtitles, metadata |
| `.t-cap` | 11 / 500 secondary | Timestamps, footnotes |
| `.lbl` | 12 / 500 secondary | Form and section labels |

Add `.num` (tabular, lining numerals) to anything showing times, counts or
codes. Hierarchy comes from size, weight and opacity, never extra colours.
At most two weights per card.

Only use a subtitle line when it carries data (a time, a name, a status).
Don't add explanatory filler under every heading.

## 5. Surfaces

- `.glass` + `.card`: screen-level card, radius 28, padding 16, blur, hairline border, top highlight, soft shadow.
- `.glass-2`: anything nested inside a card (avatars, tiles, inputs, options). Lighter than its parent, never darker.
- `.tile`: radius 20 for inner tiles.
- Lists inside a card use `.row` (hairline divider between rows) or `.lrow` for tappable rows. Don't nest cards inside cards.
- `@supports not (backdrop-filter)` falls back to the solid `*-fallback` tokens.

Spacing (8pt grid, 4px for fine adjustment): card padding 16; 12 between
related cards; 24 between sections; screen side padding 20 on phone, 24–32
on tablet and desktop.

## 6. Components

All interactive elements are real `<button>` / `<input>` elements with the
`.btn` base class, which gives: pressed `scale(.96)` (120ms), focus-visible
2px accent ring with 2px offset, disabled at 40% with no pointer events.
Minimum hit area 44×44.

| Component | Markup | Notes |
| --- | --- | --- |
| Primary button | `button.btn.pbtn.on-accent` | 56px pill, full width. One per screen. Text uses `--accent-ink` for contrast. |
| Secondary button | `button.btn.pbtn.glass` | Same shape, glass. |
| Outline accent | `button.btn.pbtn.outline-accent` | Second, urgent choice (e.g. "I need help"). |
| Icon button | `button.btn.ibtn.glass` | 44px circle (`.ibtn-sm` 40px), 20px icon, `aria-label` required. |
| Chip | `button.btn.chip.glass` | 40px pill. Selected: `.on-accent`. Use for small secondary actions and segmented choices (`role="radio"`). |
| Option row | `button.btn.opt[role=radio]` + `.radio` | Single choice lists. Selected gets `.is-sel` (accent ring + filled check). Show help text only for the selected option. |
| Toggle | `button.btn.toggle[role=switch][aria-checked]` > `.knob` + `.tl` | 88×44 track, 36px knob with power icon, "On"/"Off" label. Knob slides 180ms. |
| Stepper | `.ibtn.ibtn-sm` − value + | For numeric settings (escalation timing). |
| Quick tile | `button.btn.qtile.glass` | 88px tall, 22px icon over 12px label, equal-width grid of 2–4. |
| Text field | `input.field` / `textarea.field` | 52px pill / radius-20 box, always with a `<label>` (visible `.lbl` or `.sr-only`). |
| Tag | `span.tag` | 24px status pill. `.tag.on-accent` only for an active alert state. |
| Avatar | `.av` | 40px circle with initials. `.on-accent` only for the person with an open alert. |
| Avatar stack | `.av-stack` > `.av` | 32px solid (not glass) avatars overlapping 10px, ringed in `--bg-base`. Leftmost on top: set `z-index` descending left to right. |
| Step progress | `.seg` > `span` | Multi-step flows; done/current segments `.is-on`. |
| Sheet | `<Sheet title onClose>` | Confirmations. Bottom sheet on phone, centered dialog on larger screens, Escape closes. Destructive confirms use a glass primary, not the accent; irreversible ones (delete account) also need typed confirmation. |
| Nav slot | `button.btn.slot` | 52px circle. Active: `.is-on` (accent). Badge `.badge` for an unacknowledged alert. |
| Error | `p.error[role=alert]` + `alert` icon | Glass box, primary text. No red. |

React wrappers in `src/ui/components/Controls.tsx`: `Toggle`, `ToggleRow`,
`OptionList`, `ChipChoice`, `Stepper`, `StepBar`, `ScreenHeader`, plus
`initials()` for avatars. Use them instead of re-writing the markup.

### Data components

| Component | Use | Build |
| --- | --- | --- |
| Arc gauge | Countdowns (next escalation, check-in window) | ~200° SVG arc, 6px round stroke, gradient active stroke, white knob with accent ring, hero numeral + label inside, start/end times at the arc ends. Turns grey with no knob when stopped. |
| Tick dial | Elapsed time across a window (incident card) | 48 radial ticks generated in JS. Lit ticks fade in and grow toward the current point; the leading tick is tallest and glows; unlit ticks fade out toward the end. Hero numeral sits inside the arc. |
| Scrubber | Session progress | 3px accent line on grey, white knob with accent ring, elapsed left, remaining right (11px). |

Read-only data components use `role="img"` or `role="timer"` with an
`aria-label` that states the values in words. Never use native `<input
type="range">` or `<progress>` visually.

## 7. Icons

One family: Lucide-style line icons, 24px grid drawn at 20px (22px in quick
tiles, 16px in chips), 1.5px stroke, round caps and joins, inline SVG with
`class="ic"` and `aria-hidden="true"`. Colour comes from `currentColor`
(`--icon` by default, `--accent-icon` on accent). No filled icons, no emoji, no icon
fonts.

## 8. Layout across devices

One set of markup serves every size; CSS does the rest. The rail and
bottom nav switch at 768px viewport width. Two-column content uses
`.cols` > `.col`, which splits when `.app-main` is at least 760px wide
(a container query).

| | Phone (< 768px) | Tablet and desktop (≥ 768px) |
| --- | --- | --- |
| Navigation | Floating glass pill at the bottom | Floating vertical rail on the left |
| Session home, Alert, Incident card | One column | Two columns (`.cols`) |
| Forms and focused flows | Full width | `.narrow`, centered, max 540px |
| Help button | Pinned above the nav | Pinned at the bottom, max 440px, centered |
| Sheets | Bottom sheet | Centered dialog |

Nav slots (`AppNav.tsx`): Group, Alert (host only, while an alert is
unresolved; also active on Incident card and Call), Your sharing,
Settings. Welcome, Host setup, Join, Sign in, the private check-in and
the recipient inbox have no nav. Keep primary actions in the lower part
of phone screens.

The active-session bar (`ActiveSessionBar`) stays on every in-session
screen. It is the visible session indicator CLAUDE.md requires; don't
remove it to save space.

## 8a. Backend features

Screens must not pretend the server exists. Sign-in, account export,
sign out and delete account call the API in `src/ui/api.ts` (see
`docs/backend.md`). Every call tolerates the server being absent: the
screen says the feature needs the server, or falls back to the on-device
equivalent (Download data on this device, Delete data on this device).
Only show sign-in providers the server reports from
`GET /api/auth/providers`. Sign in and sign up are one flow.

## 9. Accessibility

- Body text ≥ 4.5:1, large text and icons ≥ 3:1 against their surface, in every theme. White text on the accent fails, so text on accent uses `--accent-ink`.
- Headings in order; every control labelled; icon-only buttons have `aria-label`.
- `role="radio"`/`aria-checked` for options and chips, `role="switch"` for toggles, `aria-current="page"` on the active nav slot.
- Live values that change (countdowns, steppers, status after an action) use `aria-live="polite"` or `role="status"`.

## 10. Motion

200–280ms, ease-out. Cards fade and rise 8px on enter (`.rise`, stagger
40ms with `animation-delay`). Toggles slide in 180ms. No looping or bouncy
decoration. `prefers-reduced-motion: reduce` turns all of it off.

## 11. Checklist for a UI change

1. Find the closest existing screen on the canvas and reuse its structure.
2. Build from the components above. If you need a new one, add it to
   this file and the canvas component in the same change.
3. Accent count: is everything accent-coloured actually active, on,
   in progress or the primary action?
4. One focal point, one primary action, no repeated facts.
5. Check it at 360, 390 and 430px wide, on tablet and desktop, and in
   all four themes, including the light ones (Onyx, Porcelain).
6. Keyboard: tab order, focus ring visible, every control reachable.
7. Copy matches `src/ui/copy.ts`; simulated things say "Simulated".
