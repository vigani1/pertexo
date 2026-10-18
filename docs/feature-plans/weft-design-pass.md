# Weft design pass

Status: in progress. Started 2026-10-18 after F18, F28, F17 and F19.

The core screens (Home, Runs, run detail, the editor, Team, Connections) speak
Weft well. Screens added feature by feature since then read like admin forms:
raw action names and IDs, rules written out as paragraphs, native date pickers,
a Save and a "Reload current values" button per section, and one spine entry per
feature. This pass makes every feature reachable from one calm structure and
gives the newer screens the same character as the core ones.

Keep the five materials, tokens, status language and shared building blocks in
[web architecture §11](../../apps/web/ARCHITECTURE.md#11-visual-design). No new
endpoint, store, package or design system. Each numbered slice is its own PR:
lint, TypeScript, unit and mocked browser tests locally, inspect the rendered
result at desktop and phone width, then rebase-merge after CI passes.

## Principles added by this pass

- **Settings read as sentences.** A setting shows its current value as one
  sentence ("Up to 3 runs at once; extra events wait their turn"). Editing opens
  that sentence in place with its controls; one Save per sentence. The rules
  behind it live in one short "How this works" disclosure or the guide, not in
  the page.
- **History is a ledger.** Audit, promotion and test history read as sentences
  with a person, a verb and a named thing ("Vigan published Order intake v3"),
  grouped by day like Runs, with the thread glyphs for outcomes. IDs stay in a
  details area with copy buttons.
- **One place per job.** The spine holds the work: Home, Workflows, Runs, Inbox,
  Data tables, Connections, then Team and Settings. Workspace administration
  lives in one Settings hub with its own section rail.
- **The canvas carries the conversation.** Discussions about a step show on that
  step; presence never counts you as someone else.

## Slices

- [x] 1. **Navigation and the Settings hub.** Trim the spine to the work above.
  Settings pages and Alerts share a section rail, a thread with one bead per
  section where the current one is a knot (Workspace: General, Usage,
  Variables, Alerts, Promotion, Audit log, Single sign-on; You:
  Notifications, API tokens); phones get it as a scrolling row. Inbox and
  Requests share one header with Notices and Requests views, each with its own
  count; waiting approvals already raise Inbox notices, so the spine badge stays
  the unread count. Remove the General page's link-only sections that the rail
  replaces. Keep every existing URL working: Alerts moves to settings/alerts and
  its old address redirects.
- [ ] 2. **Audit log as a ledger.** Sentences from a phrase table keyed by
  action, using safe metadata names, with a readable fallback for unknown
  actions. Filters become one row: person, a "What" choice by family
  (workflows, publishing, people, connections, sign-in, data, settings) and a
  date range on the shared calendar lens. "Show only this" in an event's details
  sets the target filter instead of a free-text ID field. Promotion history uses
  the same ledger rows.
- [ ] 3. **Workflow settings as sentences.** Group into Identity, Your
  notifications, When it fails (alerts, error workflow, automatic pause), How it
  runs (duration, concurrency) and Lifecycle. Move the step health table to the
  workflow's Runs tab, recent skipped triggers to its Triggers tab and the
  workspace auto-pause default to workspace Settings.
- [ ] 4. **Collaboration on the canvas.** A step with open discussions shows a
  small count on its node that opens them. Presence lists other people only,
  with your other tabs as "you, in another tab". The Comments tab drops its
  eyebrow label and shows who is here.
- [ ] 5. **One way to start.** New workflow lists Blank, patterns and examples
  together; an example is created directly with the chosen name, without a
  separate preview step. The editor shows the example's title, not its key.
  Example descriptions say what the workflow does in plain words.
- [ ] 6. **Plain words on the newer screens.** Requests, Inbox, Data tables,
  Variables, Notifications, Usage, Promotion and Single sign-on get one-sentence
  introductions; limits move into a disclosure; select values show labels, never
  enum values; Save plus "Reload current values" becomes Save plus Discard that
  appears only with unsaved changes. The editor's test bar appears once a saved
  test case exists, and Run all tests also lives in the Test workflow menu.
- [ ] 7. **A run's ending.** When a run ends at a Stop run step that names its
  outcome, run detail says it ("Succeeded as rejected in 0.57s").

Not in this pass: new backend endpoints (a reviewer's list of waiting
publication reviews still arrives through Inbox notices), moving existing
feature folders (a separate mechanical pass), F21 integrations and F22 AI.

Checked items have passed local verification; each PR records its CI and merge.
