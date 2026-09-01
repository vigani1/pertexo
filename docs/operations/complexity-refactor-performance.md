# Complexity-refactor performance comparison

Recorded: 2026-09-01

This comparison checks the owning package seams affected by the eight
complexity refactors. It is regression evidence for the refactor, not a
production load or latency claim.

## Compared revisions

- Baseline: `e3d173fe9573107c1cc9551ca2e007fbfc824e18`, immediately before the
  refreshed-audit implementation.
- Candidate: `4f38585d4746a86c59bcd1fd88de1ebce4425205`, including the complexity
  decomposition and private coordinator-validation consolidation. Its tree is
  identical to the measured pre-merge revision
  `c6530ddb801abab2209d87181f57396c64bdf087`; GitHub assigned the candidate SHA
  during the required linear-history rebase.
- Runtime: Node 24.15.0, pnpm 11.22.0, macOS 26.5.2 on the same host with the
  same dependency store.

The isolated baseline worktree received a frozen offline install and full
workspace build. The candidate workspace used the same lockfile and dependency
store and was fully built before measurement. Each package command then ran
five times through `/usr/bin/time -lp`; the table reports median wall-clock
time and median maximum resident set size as a coarse allocation/peak-memory
proxy. Tests ran through the package interface rather than importing the new
private modules.

| Owning package seam | Baseline tests | Candidate tests | Baseline median | Candidate median | Time delta | Baseline median max RSS | Candidate median max RSS | RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `@pertexo/database` unit suite | 154 | 154 | 2.81 s | 2.82 s | +0.36% | 292,929,536 B | 296,386,560 B | +1.18% |
| `@pertexo/workflow-engine` unit suite | 121 | 124 | 0.96 s | 0.99 s | +3.13% | 189,153,280 B | 189,644,800 B | +0.26% |
| `@pertexo/workflow-model` unit suite | 59 | 59 | 1.89 s | 1.89 s | 0.00% | 178,388,992 B | 178,798,592 B | +0.23% |

Raw wall-clock seconds:

| Package | Baseline rounds | Candidate rounds |
| --- | --- | --- |
| database | 2.83, 2.81, 2.86, 2.81, 2.81 | 2.81, 2.82, 2.83, 2.85, 2.80 |
| workflow engine | 0.94, 0.96, 0.96, 0.96, 0.96 | 1.00, 0.99, 1.05, 0.97, 0.99 |
| workflow model | 1.89, 1.89, 1.91, 1.89, 1.89 | 1.92, 1.90, 1.89, 1.89, 1.89 |

The candidate workflow-engine suite includes three additional exhaustive
transition-policy mutation tests. Even with that extra work, its median elapsed
time changed by 30 ms and its median peak RSS by less than 0.3%. The database
and workflow-model medians likewise show no material latency or peak-memory
regression at these seams.

## Query comparison

The extracted validator/parser/policy modules are pure: none accepts a pool or
client, imports `pg`, or executes SQL. A source inventory across the three
owning packages counted 215 `.query(` call sites at the baseline and 213 at the
candidate. Review of the refactor diff found relocated existing statements but
no new SQL statement or database round trip. The real-PostgreSQL coordinator
integration cohorts also remain green. Query count therefore did not increase
because of the complexity decomposition.

## Interpretation

These results close the audit's missing refactor comparison at repository test
scale. Maximum RSS is deliberately reported as a coarse memory proxy, not as a
claim about individual heap allocations. These measurements do not replace
Phase 7 representative deployed-load, database capacity, query-plan, or
tail-latency evidence, which remains open.
