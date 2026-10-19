# Weft second pass

Status: approved by the owner 2026-10-19 ("check as user experience and design
… do things more creatively"); in progress.

The first [Weft design pass](weft-design-pass.md) gave every screen the same
language. Using the app by hand on 2026-10-19 showed where it still feels
unfinished: things jump while data arrives, the orb looks frozen, some lists are
label/value stacks with nothing to act on, Settings' sections spill off the
edge, raw browser disclosures sit next to designed ones, and sign-in scrolls on
a phone. This pass fixes those and audits every page at the in-app pane's width
(~1000 px) and a phone (390 px) for the same faults.

Keep the five materials, tokens and status language in
[web architecture §11](../../apps/web/ARCHITECTURE.md#11-visual-design). No new
endpoint, store or package.

## Principles added by this pass

- **Nothing jumps.** A block keeps its size from skeleton to data and between
  views of the same page. Lines that arrive later get their space reserved.
- **The Core is alive.** It always drifts; live work makes it quicker and
  brighter. A loader never stands still. Only reduced motion holds drawings
  still, plus off-screen canvases and hidden tabs, which no one sees.
- **A list is for acting.** A row says what it is, why it's there and what to
  do next, and offers the next step in place when it's safe.
- **One disclosure.** Every "show more" uses the same control.
- **Panels make room.** A detail panel sits beside what it describes when there
  is room, and selected rows keep their padding inside the highlight.
- **A sign-in fits the screen.** Nothing sits below the form on a phone.

## Slices

- [ ] 1. **Motion.** The Core idles everywhere: callers drop `still` and pass a
  low energy when nothing runs. Canvases animate on touch devices and in
  visible windows without focus (the in-app browser loses focus whenever the
  chat has it); reduced motion, off-screen and hidden tabs still stop them. The
  `motion-loop` variant drops its touch condition. Under reduced motion the
  loading orb fades in place instead of freezing.
- [ ] 2. **Nothing jumps.** Inbox keeps one header for Notices and Requests.
  Workflow rows reserve their preview and step-path line while those load, so
  filtering and first load keep row heights.
- [ ] 3. **Settings navigation.** The section rail stands beside the page from
  the medium breakpoint, not only on very wide screens. Phones get one "section"
  button that opens the grouped list in a sheet.
- [ ] 4. **Requests as a queue.** Each request is one compact row: glyph,
  title, workflow, its details as a short "Amount 120 · Customer Ada" line,
  then either time left with Approve and Reject (only when you can decide;
  comments stay on the request page) or who decided and when. Filters fold
  into one row. The request page leads with the decision: details as a
  grid, the instructions as the brief, the outcome as the closing entry of a
  short history.
- [ ] 5. **One disclosure.** A shared `Disclosure` (chevron, padding, focus)
  replaces the raw `<details>` across the app. A run's workspace variables read
  as a captured set: names in mono, values that wrap, copy, and the captured
  revision.
- [ ] 6. **Selection and panels.** Selected rows (run thread first) keep inner
  padding and an inset highlight. Run detail places the step panel beside the
  thread from the large breakpoint, and selecting a step below that scrolls its
  panel into view.
- [ ] 7. **Sign-in on a phone.** The pitch shows only on wide screens; the orb
  scales with the screen height so sign-in, sign-up and reset fit without
  scrolling past the form.
- [ ] 8. **Second look.** Fix what the audit finds on the remaining pages at
  both widths: the trigger-less Triggers tab, the Connections app tiles, the
  workflow Runs tab's controls on a phone, doubled dividers on Variables, and
  the Inbox notice timelines.

## Verification

Lint, TypeScript, unit and mocked browser tests; screenshots of every changed
page at 1000 px and 390 px before and after; the iPhone Simulator for motion
and sign-in. Small fixes ship together in one PR per few slices, per the merge
practice.
