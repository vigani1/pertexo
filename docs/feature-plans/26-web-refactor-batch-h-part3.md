# Web refactor batch H part 3

Scope: audit findings WR1–WR8, WA2/WA4–WA9 and WC2–WC8, then a structure
pass over their owning feature areas. Reuse the shared snapshot, command expiry,
read recovery and clock seams delivered in part 1. Workflow authoring and
publication folders belong to part 2 and remain outside this slice.

Acceptance is visible behavior at the screen/HTTP boundary: retained answers and
files, specific recoverable refusals, truthful read/loading states, URL/history
and focus, and coherent snapshot/window identity. Each fix has a failing then
passing regression. Moves/renames are separate from behavior changes.

Workspace deletion is visible to current members while purging. Discovery uses
its own named policy status list; other unpurged callers keep their current
semantics. Membership deletion runs last if dependencies permit it. A session
that observed purging may show completion after authoritative disappearance;
a fresh visit after deletion keeps the ordinary non-disclosing unavailable
answer. No ownership tombstone or retention exception is introduced.

Validation: each commit passes `pnpm check`; focused core/API integration uses
test-stack offset 4200. Handoff requires the bounded whole web unit suite and
full mocked Chromium on 5410, plus affected package tests and export integration
checks. Audit receipts, measurements and clone decisions live outside the code
worktree in `.pertexo/audits/refactor/batch-h-part3.md` and its evidence folder.
