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
- [ ] Complete local behavioral verification and existing green CI before merge.

Use mechanical file moves and module-path rewrites only. Verify each commit with
lint, TypeScript and existing relevant behavior suites plus architecture checks.
The final PR also qualifies the built browser and actual worker/database paths;
record CI/rebase merge and natural-main results on the delivery PR. Historical
reset/ADR records keep their original paths; current architecture describes the
new owners. No speculative wrappers or new barrels.
