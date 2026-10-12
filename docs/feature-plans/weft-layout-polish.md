# Weft list and phone header polish

Use the existing Weft glyphs, tokens and accessible controls. Deliver each
requested layout correction in its own PR; verify lint, TypeScript, unit and
mocked browser tests, then rebase-merge after all CI checks pass. Preserve
selection, command, dialog and save ownership.

- [x] 1. Put row selection in the glyph column without changing row height.
  Desktop hover/focus reveals it; touch and an existing selection keep it
  visible. Only tagged workflows get an additional tag line. Long menus stay
  within the available viewport height and scroll when needed.
- [ ] 2. Below sm, share one overflow menu for Export, Input cases, Duplicate,
  Contract and editor history. Keep Issues, Run and Publish together on one
  row, including at 375px.

Check row geometry before and during selection, tag and readonly behavior,
touch targets and keyboard focus. Check the phone header with issue counts,
publication labels and save recovery; dialogs keep their existing owners.

Checked items have passed local verification; each PR records its CI and merge.
