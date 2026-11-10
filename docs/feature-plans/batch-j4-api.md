# Batch J4 — Reviewed public reads and workflow list summaries

Expose the existing portable graph digest on draft and immutable version reads
only with `include=graphDigest`; default read/write shapes remain pre-J4 compatible.
Clients review the graph and echo `graphDigest` as `reviewedGraphDigest`; the
opaque draft ETag remains the write precondition. Document the shipped image CLI.

Add optional `listSummary` to workflow summaries only with `include=listSummary`
(or `include=organization,listSummary`). Both ordinary and organized
lists fetch topology without configuration, connection references or input
mappings, plus the last 20 ordinary run statuses, in one extra query per page.
Use an ordinary-run partial index on workspace/workflow/created/id and folder scope; token responses
also require `run:read`. The browser renders rows directly from the list snapshot,
retaining the page's access-loss handling.

Verification: digest regression, viewer/folder/workspace isolation, a bounded
query measurement at 50 and 500 workflows, request counts at 50 workflows before
and after, API/core/contracts tests, complete web unit suite, list browser specs,
and `pnpm check`. No new endpoint or deployment subsystem. The accepted J4 review adds the first
post-baseline migration (`0001_ordinary_run_history.sql`) in the existing
maintenance window, plus a test-heavy `EXPLAIN (ANALYZE, BUFFERS)` regression.

First-render test waits use the existing `coldStart` budget: a lazy route can
still be compiling after the ordinary 3-second render wait. This is a compilation
budget, not a relaxed product assertion. Keep all visibility, path, trigger and
run-status expectations; list fixtures now supply topology/status in the summary.

The baseline-adoption fixture selects only the baseline for its adoption step,
then supplies its own later migration; release migrations must not run inside
that synthetic history. Preserve its catalog/data equality assertions.

The accepted compatibility correction adds a response-only schema policy for
public token-route projections, including nested DTOs and bounded graphs. Clone
shared validators so request/query schemas remain strict. Keep explicit stored
format validation. Extract read-query declarations to own projection options and
pagination constraints. Web and CLI request projections; web exports echo the
server-reviewed digest. Freeze the previous release's response declarations in
an API test fixture and run them against actual default HTTP responses.

Replace public-response assertions that rejected extra/private fields with
assertions that the parsed projection excludes those fields. This is the accepted
forward-compatibility behavior, not permission to relax requests, required fields,
known-value validation, bounds, access checks or leakage assertions.
