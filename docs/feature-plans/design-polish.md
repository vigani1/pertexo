# Non-editor design polish

Keep the existing Weft visual system and current frontend contracts. Editor
canvas, inspector and test-history changes belong to the separate editor pass.

- Use the existing Empty composition for Inbox, Connections and data tables.
- Distinguish empty tables, filtered results and empty pages in row copy/counts.
- Share dialog footer layout: Cancel/Close, supporting actions, primary action;
  DOM and visual order agree, and actions wrap within narrow dialogs.
- Share an accessible native-input drop target across artifact, CSV and workflow
  imports, retaining feature-owned validation and upload recovery.
- Show the existing role summary and Team comparison link without repeating the
  role matrix; give auth product facts an opaque semantic background.
- Sweep the requested non-editor pages at 360, 390, 768, 1024, 1440 and 1920px,
  light/dark; fix observed overflow and provide 44px phone button targets. The
  Build route retains editor-owned compact geometry; portalled dialogs use the
  app target minimum.

Verify component behavior, mocked browser journeys, all six viewport sizes in
both appearances, build/typecheck, lint and unit tests. Screenshots and the full
change inventory live in the external round-13 audit notes, not the repository.
