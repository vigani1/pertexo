# Weft workflow list polish

Use the existing Weft glyphs, tokens and accessible controls. Deliver each
requested layout correction in its own PR; verify lint, TypeScript, unit and
mocked browser tests, then rebase-merge after all CI checks pass. Preserve
selection, command, dialog and save ownership.

- [x] 1. Put row selection in the glyph column without changing row height.
  Desktop hover/focus reveals it; touch and an existing selection keep it
  visible. Only tagged workflows get an additional tag line. Long menus stay
  within the available viewport height and scroll when needed.
Check row geometry before and during selection, tag and readonly behavior,
touch targets, keyboard focus and long owner menus. The phone editor header
has its own plan and PR.

Checked items have passed local verification; each PR records its CI and merge.
