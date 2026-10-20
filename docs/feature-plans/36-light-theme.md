# F36 — Light and dark appearance

Status: implemented and locally qualified; owner-approved on 2026-10-20.

## Decisions and rules

- Account → Profile → Appearance offers System (default), Light and Dark. The
  preference belongs to this browser, across workspaces and sign-in sessions;
  it is not workspace policy. Explain that beside the control. Persist only the
  enum in localStorage, synchronize tabs, and keep an in-memory choice when
  storage is unavailable. System follows live OS changes. No backend preference
  subsystem or account migration is needed for a device display preference.
- One TypeScript owner resolves, persists and applies the choice. Vite injects
  its small synchronous bootstrap before first paint; the React
  control subscribes to that same owner. The boot ground, text, browser chrome,
  native controls and application share the resolved palette. Invalid/missing
  storage falls back to System. The bootstrap works before authentication.
- First commit migrates neutral utility colours, canvas inks, gradients, glass,
  shadows and textures to semantic tokens, preserving dark values. Mask colours
  and third-party brand logos are intentionally not theme colours.
- Weft light follows the [Radix light-scale roles](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)
  (revised 2026-10-20 after owner review: the first palette had too little
  structure, and a mid-grey ground with a dark rail was dingy and loud): a
  near-white sage ground #f7f9f8, surfaces #fbfdfc, hairline borders
  #d7dad9/#b8bcba, ink #16262b, muted #4e5c60, cyan #0b7590 for text and
  actions and violet #6550b9. Drawings use the saturated step-9 solids (cyan
  #00a2c7, violet #6e56cf, red #e5484d, jade #29a383) so the Core, aurora and
  canvas grid stay visible on white. Never a mid-grey ground. Keep
  Bricolage/Inter/JetBrains, flat content, floating glass, thread glyphs, real
  Loom data and bounded motion. Status inks become deeper rather than inverted.
  Light particles use normal compositing; dark keeps additive light. Theme
  changes repaint even reduced-motion canvases.
- Text needs WCAG AA (4.5:1 ordinary, 3:1 large); meaningful controls, focused
  outlines and chart marks need 3:1. Decorative low-alpha cloth and glows carry
  no information. Keep labels in addition to status colours. Respect reduced
  transparency, forced colours and reduced motion.

References: [n8n personal theme choice](https://www.linkedin.com/posts/n8n_n8n-quick-tip-for-night-owls-activate-dark-activity-7224791474461114368-XQyP),
[Zapier System/Light/Dark](https://help.zapier.com/hc/en-us/articles/15932034572685-Customize-branding-and-colors-in-Zapier-Forms).
These support a familiar explicit appearance choice; they do not prescribe
Pertexo's palette or persistence. Make's documentation does not establish an
additional appearance requirement.

## Ownership and delivery

| Part | Owner | Status |
| --- | --- | --- |
| Semantic token pass, dark unchanged | styles/globals.css, existing renderers and shared primitives | Complete |
| Bootstrap and subscription | lib/appearance; Vite HTML injection | Complete |
| Appearance control | auth/components/account/appearance, account profile page | Complete |
| Light palette and canvas redraw | styles and existing canvas lifecycle owner | Complete |
| Qualification and docs | web tests, e2e, README and architecture §11 | Complete |

## Verification

- Compare deterministic dark renders before/after the token pass. Build, lint,
  typecheck and unit tests gate both implementation commits.
- Browser tests cover System/live changes, explicit overrides, reload before app
  script, invalid/blocked storage, tab synchronization and keyboard selection.
- Inspect the page inventory in both themes at desktop, 990px and 375px:
  authentication/account/entry; home/overview, workflows/editor and its dialogs,
  versions/settings/triggers, runs/detail (graph and timeline), connections,
  alerts, inbox/approvals/forms, variables/tables, team, usage/trends, audit,
  identity providers/promotion/settings/tokens and error/empty states.
- Measure actual rendered text/control contrast and inspect editor, run detail,
  orb and Loom. Run the existing mocked journeys and React Doctor, then the full
  pre-push hook. Record evidence and any limits here before delivery.

No integrations, AI, theme packages, custom themes or per-workspace appearance.

Token qualification: nine deterministic renders (public error state, workflows and editor at
1440/990/375 px) match the prior dark appearance. The public error state is pixel-identical;
other surfaces differ by at most one RGB level from alpha colour interpolation.
No geometry or readable contrast changed. Baselines are local qualification
artifacts under `/tmp/pertexo-f36-visual`, not application assets.

Contrast qualification also removes zero-count label fading, makes light Loom
labels/threads opaque and gives meaningful graph links a readable ink. The node
card used an invalid combined image/colour value; separate background colour
and gradient now make its intended solid fill work. Light node shadows are
shorter and softer than dark ones.

Final qualification (2026-10-20): build/types and lint pass; 1,404 web unit tests;
243 mocked journeys in dark, 236 plus seven added page journeys in light, and
15 focused appearance/page checks. Automated rendered contrast checks cover 49
routes in both palettes at 1440, 990 and 375 px with no reported failures.
Decorative gradients produce some incomplete automated checks; the editor,
run detail, Loom, glass and Core also receive rendered inspection. Light Loom
labels/threads use opaque ink; graph-link ink exceeds 3:1 on its ground.
React Doctor reports no findings (91/100, including the token-only pass).
Browser screenshots and contrast manifests stay in `/tmp/pertexo-f36-audit`.
The existing >500 kB editor chunk warning remains; this feature adds no runtime
dependency. Full pre-push verification is required before PR delivery.

## Quick appearance access (2026-10-20)

The account menu and the phone's More sheet offer System, Light and Dark.
The command palette's Switch theme opens the same three-way choice, and
Account → Appearance remains available. All use lib/appearance; Tailwind dark
variants follow data-theme rather than the OS preference directly.
