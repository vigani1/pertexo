# F37 — Notes on the workflow canvas

Owner-approved 2026-10-20. Status: implemented.

## Decisions and rules

- Notes document the workflow on its canvas. F19 comment threads remain separate
  discussions, with their existing mentions, permissions and retention.
- Add note from the canvas toolbar; double-click/tap or use Edit to write it.
  Plain Markdown supports headings, paragraphs, bold, italic, lists, quotes,
  inline/code blocks and safe links. No raw HTML, images, embeds or scripts.
  Use a maintained Markdown-to-React parser rather than a hand-written parser;
  rendering emits React elements and never injects HTML or fetches note content.
  Bound formatting to 32 AST levels before recursive rendering; deeper notes
  display their full, unchanged source as plain text with a reason. This is a
  rendering limit, not another stored format or server-side Markdown parser.
- A note has a stable ID, text, position, size and one Weft colour: neutral,
  teal, violet, sage or amber. Default 320×200 px; minimum 200×120 and maximum
  1,200×1,200. Position is finite and bounded to ±100,000 canvas units. At most
  100 notes, 4,000 characters each, still inside the existing 1 MiB graph budget.
- One optional top-level `notes` array in WorkflowGraph, alongside its nodes and
  positions. It is not a node definition or structured-body graph. Notes can
  sit behind steps to document an area, including loop containers; moving one
  does not move/group steps. No new table, service, role or execution format.
- Existing workflow read/edit permissions apply. Draft persistence, revisions,
  conflicts, autosave and undo/redo keep their existing owners. Pointer movement
  and resizing commit one undoable change at gesture end. An explicit edit form
  and numeric position/size controls provide equivalent keyboard/phone actions.
  Deleting a note offers Undo. A toolbar list opens each note's edit form,
  including covered/off-screen notes, with full-size phone controls. Read-only
  viewers can read notes.
- Notes travel with the draft and immutable published graph. Notes-only changes
  may produce a new published version with the same executable checksum. Reuse
  requires the executable checksum AND identical note metadata (absent/empty
  notes are equivalent); the current position-only reuse behavior for steps is
  unchanged. Remove the workflow/checksum uniqueness constraint, retaining
  immutable version IDs, version numbers and exact-version Call binding.
  Record this hard-to-reverse publication distinction in ADR 089.
- Notes never enter the compiled executable, execution identity, step sample
  bindings or pin staleness. Version comparison and conflict summaries show
  added, edited/moved/resized/recoloured and removed notes. Restoration,
  duplication, portable import/export and promotion retain them; no notes are
  copied into F19 comments or run events. Run maps remain execution views.

The interaction follows [n8n sticky notes](https://docs.n8n.io/build/understand-workflows/workflow-components/add-notes-and-documentation.md).
[Zapier notes](https://help.zapier.com/hc/en-us/articles/16791272000525-Describe-how-your-Zap-works-by-adding-notes)
support published documentation; [Make notes](https://help.make.com/scenario-notes)
support concise shared context. Pertexo uses its existing graph metadata and
Weft palette, with no HTML storage, external embeds or arbitrary colours.

## Ownership and slices

| Part | Existing owner / placement | Status |
| --- | --- | --- |
| Graph note contract and limits | workflow-model graph contract, focused notes helpers; contracts reuse it | Implemented |
| Publication reuse and unique-constraint migration | database authoring publication/reads, schema/migrations; ADR 089 | Implemented |
| Canvas projection, editing and gestures | workflow-editor components/canvas/notes; pure graph/note commands | Implemented |
| Diff and conflict presentation | workflow-drafts graph diff; workflows version comparison and settings view | Implemented |
| Portability, duplication and promotion | existing graph transformations, with preservation tests | Implemented |
| Guides, roadmap and qualification | web/model/engine/database/API tests; browser journeys | Implemented |

One PR. Keep any necessary moves in move-only commits. Do not introduce a new
selection store, graph mirror, execution node or authoring format version.

## Verification

- Schema bounds, duplicate note IDs, malformed geometry and aggregate size.
- Compile the same workflow with/without notes: exact executable and checksum
  equality. Pin bindings and existing samples remain current after note edits.
- PostgreSQL: publish note-only edits, reuse identical notes, restore retained
  notes; same-checksum versions remain independently immutable and Call-safe.
  Migration upgrades a populated database. Keep migration/schema inventories.
- Round-trip export/import, whole-workflow duplication and promotion; no data
  loss through explicit graph projections. Diffs include every note operation.
- Real browser: add/edit/drag/resize/delete/undo/save/reload, read-only access,
  keyboard and 375px controls, conflicts and Markdown safety. Check both themes
  when F36 is available, without depending on its unmerged implementation.
- Build, lint, types, relevant unit/integration tests, mocked e2e, React Doctor
  and the complete pre-push hook. Record results before enabling rebase merge.

Later: semantic grouping/moving steps with notes, images/embeds, custom colours,
live co-editing and integrations/AI.

## Qualification (2026-10-20)

- Build, lint, full workspace types, dependency boundaries, generated contracts,
  migration/schema ownership and architecture checks pass.
- Over 1,400 web unit tests and 16 focused note checks pass. Focused model (11), engine identity (23) and
  publication comparison (3) tests pass. The engine test compares the exact
  executable envelope and checksum; the model test compares pin bindings.
- Real PostgreSQL: 18 tests across publication/restore/duplication, promotion
  and all five populated historical migration upgrade fixtures pass.
- All 260 mocked browser journeys pass, including six note journeys across
  1440/990/375 px in both themes, Markdown safety/read-only access, pointer
  gesture undo and note-only conflict reapplication. An additional touch-device
  journey verifies off-screen notes can be moved, resized, edited, deleted and
  restored through the toolbar and ordinary form. Rendered canvases and the
  phone form receive visual inspection. A regression also moves an imported
  `note:<uuid>` step and a note independently; projection IDs cannot collide
  with any valid persisted step ID. Deeply nested valid Markdown is covered by
  parser/rendering regressions and an editable imported-note browser journey.
- React Doctor: 100/100 for changed files, no findings. Markdown is lazy-loaded
  (about 36 kB gzip); the existing >500 kB editor-chunk warning remains.
- Run the complete pre-push hook before delivery. No hook bypass, new service,
  role or CI job. Integrations and AI remain later.
