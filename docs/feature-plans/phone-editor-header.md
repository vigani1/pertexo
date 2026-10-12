# Weft phone editor header

Keep the existing Weft components, tokens and command ownership. Deliver the
phone header correction in one PR; verify lint, TypeScript, unit and mocked
browser tests, then rebase-merge after all CI checks pass.

- [x] Below sm, share one overflow menu for Export, Input cases, Duplicate,
  Contract and editor history. Keep readable Issues, Run and Publish together
  on one row at 375px. Dialogs remain owned outside the menu and restore focus
  to the visible opener. Bound the shortcuts popup to the phone viewport.

Check 320px and 375px with keyboard and touch, desktop controls, save recovery,
publication labels, dialog persistence and reduced motion. Keep complete
accessible names when a phone control uses a shorter visible label.

Checked items have passed local verification; the PR records its CI and merge.
