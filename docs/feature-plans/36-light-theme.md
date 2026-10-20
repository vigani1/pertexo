# F36 — Light and dark appearance

Status: planned; owner-approved on 2026-10-20.

## Decisions and rules

- Account → Profile → Appearance offers System (default), Light and Dark. The
  preference belongs to this browser, across workspaces and sign-in sessions;
  it is not workspace policy. Explain that beside the control. Persist only the
  enum in localStorage, synchronize tabs, and keep an in-memory choice when
  storage is unavailable. System follows live OS changes. No backend preference
  subsystem or account migration is needed for a device display preference.
- One TypeScript owner resolves, persists and applies the choice. Vite injects
  its small synchronous bootstrap before styles and first paint; the React
  control subscribes to that same owner. The boot ground, text, browser chrome,
  native controls and application share the resolved palette. Invalid/missing
  storage falls back to System. The bootstrap works before authentication.
- First commit migrates neutral utility colours, canvas inks, gradients, glass,
  shadows and textures to semantic tokens, preserving dark values. Mask colours
  and third-party brand logos are intentionally not theme colours.
- Weft light uses cloth #f4f6f5, surface #ffffff, ink #183139, muted #435b63,
  teal #006b79 and violet #63449a. Keep Bricolage/Inter/JetBrains, flat content,
  floating glass, thread glyphs, real Loom data and bounded motion. Status inks
  become deeper rather than inverted. Light particles use normal compositing;
  dark keeps additive light. Theme changes repaint even reduced-motion canvases.
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
| Semantic token pass, dark unchanged | styles/globals.css, existing renderers and shared primitives | Pending |
| Bootstrap and subscription | lib/appearance; Vite HTML injection | Pending |
| Appearance control | auth/components/account/appearance, account profile page | Pending |
| Light palette and canvas redraw | styles and existing canvas lifecycle owner | Pending |
| Qualification and docs | web tests, e2e, README and architecture §11 | Pending |

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

Token qualification: nine deterministic renders (login, workflows and editor at
1440/990/375 px) match the prior dark appearance. Login is pixel-identical;
other surfaces differ by at most one RGB level from alpha colour interpolation.
No geometry or readable contrast changed. Baselines are local qualification
artifacts under `/tmp/pertexo-f36-visual`, not application assets.
