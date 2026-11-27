# Weft third pass

Status: drafted 2026-11-27 from the owner's review of the third design pass;
waiting for the owner's go.

The design lives on the private design canvas (pages "Design system" and
"Third pass"). The owner's feedback on the second pass: too many colours, the
sidebar and status indicators change from page to page, the lines into the orb
look half done, pages are overfull, dropdowns sit inside sentences, thick
one-sided borders read as generated. This pass rebuilds the visual system on
those rules and applies it to every screen.

## Rules this pass adds

- **Colour means attention.** A page that needs nothing is ground, ink and
  hairlines. Success is ink. Cyan is live work and, in dark mode, the one main
  action; red, violet and amber colour only a status mark, an error code or the
  soft tint of a notice.
- **One status mark per state**, the same 20 px mark on every page, always with
  a word: running, succeeded, failed, waiting, queued, needs attention, draft,
  skipped, off.
- **Tokens by role, two values each.** Components read semantic tokens only;
  light mode is the same names with Cyanotype values. No raw colour in a
  component, and no `.light .thing` overrides.
- **No coloured edges.** No side bars, bottom strips or borders thicker than
  1.5 px; selection lifts the background and focus is a ring.
- **One column by default.** List and detail only where people step through
  many items; drawers create and edit; dialogs only confirm what can't be
  undone; long lists show five, then "Show all N", with search above 20.
- **Choices sit in forms and filters**, never inside a sentence. Dates are
  presets plus a calendar where one click picks a day.
- **Threads into the Core** end inside its shell and fade there.

Keep Tailwind-first and the token rules in
[web architecture §11](../../apps/web/ARCHITECTURE.md#11-visual-design); this
pass changes token values and adds the missing roles, it does not add a second
stylesheet.

## Structure

The pass also leaves the front end uniform, so the next screen is built from
parts instead of copied:

- **One home per piece.** Primitives in `components/ui/` (button, field,
  toggle, tabs, filter, calendar, drawer, dialog, tooltip); domain-free
  compositions in `components/patterns/<area>/` (status mark, rule heading,
  rows and "Show all", inline notice, arriving notices, empty and loading
  states, date picker, list and detail, page header, the Core and its
  threads). A feature never restyles a primitive or keeps a private copy of a
  pattern; it uses the variant, or the variant is added in the shared piece.
- **Variants, not overrides.** Deliberate differences are CVA variants;
  `className` passes layout only (width, placement), never colour, radius or
  type.
- **Tokens only.** Colour, type size, radius, shadow and duration come from
  `styles/globals.css` through Tailwind's theme; no hex, `rgb()` or arbitrary
  colour values in components.
- **Pages read as layout.** A page composes patterns; rules and formatting
  stay in `model/` and `lib/format/`.
- Before slice 1, list the duplicates to fold in (status glyphs, row
  dividers, section headings, empty states, notice frames, date inputs) and
  where each one goes; each slice removes the duplicates it replaces.

## Responsive

Every screen works at phone (390), tablet (768 and 1024, portrait and
landscape) and desktop (1280 and 1440). Layout follows the container where a
block can sit in different widths (container queries), the viewport for the
shell. On tablet the rail stays; list and detail becomes list, then detail
with a back link, below about 900 px; drawers take the full width below 600
px; the canvas is usable by touch (pan, zoom, select, open a step). Touch
targets are at least 40 px on touch screens. No horizontal page scroll at any
width.

## Scope

In: every screen on the "Third pass" page, desktop and phone, both themes.

Backend changes use existing endpoints:

- Version history requests the workspace-visible publisher. If the reader
  cannot see the publisher as a current member, history says “A former member”.
- Team's member list accepts the bounded people search (`q`), with "Show all"
  per role.
- Schedule next runs accepts a day window for the Triggers strip. The existing
  occurrence count still governs the per-schedule preview.

Out, removed from the designs because the code has no source for them:
recently sent alerts, which workflows use a data table, per-trigger switches
for webhooks and forms (pausing the workflow covers it), "last active" on Team,
a monthly run limit, and an assistant conversation (it stays one request, one
proposal, shown in a side panel).

## Slices

The slices land in four PRs (1–4, 5–6, 7–9, 10), each with auto-merge on and a
fresh review alongside. Work never waits for a PR: the next batch starts on a
local branch from the previous one and is replayed onto main when its PR
opens.

- [ ] 1. **Tokens.** Retune `styles/globals.css` to the Weft values for dark
  and light; add the missing roles (live and its text colour, waiting, the soft
  intent tints, the three selection layers, raised and sunken shadows); align
  the type scale, radii and motion durations. Replace raw colours and
  light-only overrides in components with tokens. Update §11.
- [ ] 2. **Status marks.** One `StatusMark` used by every status glyph (runs,
  steps, inbox, connections, triggers, versions); remove the others.
- [ ] 3. **Shell.** The rail in the real order with its badges and the 40 px
  Core; the Settings word list; the phone bar. Same on every page.
- [ ] 4. **Controls.** Button, tab, filter, toggle, checkbox, radio and field
  states as on the Components sheet; inline notice; arriving notices from the
  Inbox with the time-left ring; the date picker; drawers for create and edit.
  Remove every dropdown inside a sentence.
- [ ] 5. **Core flow.** Home (needs you, the last hour into the Core),
  Workflows (one quiet line each, failure ticks), Runs (7-day strip, grouped by
  day, plain durations), a failed run, Inbox and the approval with what each
  answer does.
- [ ] 6. **Canvas.** Header with the five tabs, lanes, results under steps, the
  running step's halo, the assistant as a side panel with one proposal, AI
  steps.
- [ ] 7. **Workflow tabs and workspace.** Triggers, Versions (with published
  by), Workflow settings, Connections (lines only for the selected one, many
  users), Data tables, Team (groups, search, invite drawer).
- [ ] 8. **Settings.** General, Usage, Alerts, Audit log (calendar), Account,
  Notifications, API tokens, Promotion, SSO.
- [ ] 9. **Entry and system pages.** Sign-in, workspace picker, public form,
  command palette, not found and error pages.
- [ ] 10. **Phone and light audit.** Every page at 390 px and in light mode;
  fix what the audit finds.

The faster Core (particles drawn on the GPU in one call, Canvas 2D kept as the
fallback) is separate: measure first, then decide.

## Verification

Per slice: `pnpm check`, the unit and mocked browser tests of the touched
features, and screenshots of every changed page at 1440, 1024, 768 and 390 px
in both themes, compared with the canvas. Slice 1 also checks contrast of each
text token on its ground in both themes.
