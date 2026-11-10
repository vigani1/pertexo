# Batch J4 — Reviewed public reads and workflow list summaries

Expose the existing portable graph digest on draft and immutable version reads.
Clients review the graph and echo `graphDigest` as `reviewedGraphDigest`; the
opaque draft ETag remains the write precondition. Document the shipped image CLI.

Add optional `listSummary` to workflow summaries. Both ordinary and organized
lists fetch topology without configuration, connection references or input
mappings, plus the last 20 ordinary run statuses, in one extra query per page.
Use the existing workspace/workflow run index and folder scope; token responses
also require `run:read`. The browser renders rows directly from the list snapshot,
retaining the page's access-loss handling.

Verification: digest regression, viewer/folder/workspace isolation, a bounded
query measurement at 50 and 500 workflows, request counts at 50 workflows before
and after, API/core/contracts tests, complete web unit suite, list browser specs,
and `pnpm check`. No new endpoint, migration or deployment subsystem.

First-render test waits use the existing `coldStart` budget: a lazy route can
still be compiling after the ordinary 3-second render wait. This is a compilation
budget, not a relaxed product assertion. Keep all visibility, path, trigger and
run-status expectations; list fixtures now supply topology/status in the summary.
