# Runtime and run-model layout follow-up

Owner approved this move-only follow-up on 2026-10-14 after F09, F24 and F16.
No runtime behavior, public entry point, node identity/version, stored format,
role, dependency, service or CI job changes. Keep complete step folders intact.
Each group is its own buildable move commit; one delivery PR after all groups.

| Owner | Grouping |
| --- | --- |
| nodes-core/src | `triggers/` (Manual/Schedule/Webhook), `flow/` (control steps), `data/` (Date/Set/Validate and `lists/`) |
| nodes-core/src/data/lists | Seven list step folders plus private `semantics/`; retain registration/public roots |
| web/features/workflow-runs/model | `commands/` for command/recovery intent; `presentation/` for run wording/status; retain existing list/timeline/loom/inspection owners |
| database/src/runs | Recovery contract/acceptance/reads in `recovery/`; publication/event reads in `queries/`; initial checkpoint interface in `commands/`; retain `/runs` public door |

- [x] Group core node folders; update imports and current F24 ownership docs.
- [x] Group web run models; update imports without UI/logic changes.
- [x] Group database run files; update imports without persistence/logic changes.
- [x] Complete local behavioral verification.
- Existing green CI remains the merge gate; record its outcome on the delivery PR.

Use mechanical file moves and module-path rewrites only. Verify each commit with
lint, TypeScript and existing relevant behavior suites plus architecture checks.
The final PR also qualifies the built browser and actual worker/database paths;
record CI/rebase merge and natural-main results on the delivery PR. Historical
reset/ADR records keep their original paths; current architecture describes the
new owners. No speculative wrappers or new barrels.


## Local qualification

Core moves 98 files intact and rewrites 105 module-path literals; web moves eight
models and rewrites 43 references; database moves six files and rewrites 60
references. Temporary semantic-AST comparison confirms unchanged code after
resolving moved paths (101/43/28 affected files), including identifiers, literals,
operators, declaration flags and type-only imports. Formatting/comments do not
enter that comparison. Git can pair identical step `index.ts` files across
folders in its rename display; the physical four-file step folders stay intact.

Top-level entry counts: nodes-core 28 → 9; web run model 13 → 7; database runs
13 → 10. Database queries has ten files, commands eight and recovery three.
Existing public package/feature doors, source boundaries and schema ownership
checks pass; historical reset/ADR paths remain history.

Each move commit passed relevant lint/types/unit/architecture checks. Final
repository checks and all unit suites pass (nodes 175, catalog 1,238, database
539, web 1,153, API 1,982, worker 720, CLI 64, ops 55), plus all 161 mocked e2e
cases. The real PostgreSQL/Redis worker executes eight transforms in For each
and the 4,998-item chain; actual browser/API/worker regressions verify 5xx/network
unknown-outcome recovery, unchanged source/input/version/reused prefix and the
compiled CLI issuance/import/publish/run/revocation journey, with independent SQL.
The owner's checkout edits, runtime services and data remain untouched.

React Doctor's changed scan reports no diagnostics (score 93). Full current and
immutable-main baseline scans both score 81 with the same 13 diagnostics; all
fields match except path-derived fingerprints and one import-shifted byte offset.
No new finding or score regression, suppression, or logic edit. Those pre-existing
warnings remain outside this explicitly move-only follow-up.
