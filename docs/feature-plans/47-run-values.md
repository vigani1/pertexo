# F47 — Run values

Status: **Implemented 2026-10-21**, awaiting green CI and rebase merge. Owner-approved scope; reconciled with current code.

## Outcome and decisions

Save a small amount of plain business metadata, such as `orderId = A-1042`,
then find the execution by that exact pair. Follow
[n8n custom execution data](https://docs.n8n.io/build/understand-workflows/understand-executions/customize-executions-data):
text keys up to 50 characters, text values up to 255 and at most ten pairs.
Use the existing run/preview execution and retention owners, not another store
or execution mechanism.

- Add **Save run values** (`core.run_values@1`), an internal safe-to-repeat data
  step. Normal mappings provide an object with one to ten key/value pairs. Keys use ASCII
  letters, digits, underscore, dot and hyphen, beginning with a letter or digit.
  Values are strings, including empty text; preserve case and whitespace.
  Invalid text, NUL and unpaired surrogates fail clearly at the step boundary.
  No implicit conversion, truncation, secret fields or arbitrary expressions
  beyond the existing mapping language.
- The ten-key bound applies to the entire execution, including multiple steps,
  loop iterations and parallel branches. Saving a key again replaces its earlier value. Later committed writes win. Serialize on
  the existing run/preview owner row; count the resulting distinct keys in
  TypeScript and refuse an eleventh atomically, with no partial writes.
- Save through an attempt-scoped capability, enforcing the existing execution
  lease/fence before mutation. An expired or canceled attempt cannot overwrite
  newer values. Repeating the same invocation upserts the same pairs; no new
  receipt, queue or coordinator. Return the saved, sanitized pairs as ordinary
  bounded step output.
- Values are visible to people who can read the execution. Explain **Use
  business data, never secrets** beside the editor. Preserve provider/HTTP
  known-secret redaction before values become mapping sources; reuse existing
  credential-text redaction at the metadata boundary and in returned output.
  Test a credential echoed by a real HTTP response and credential-like pasted
  text. Do not introduce a credential-scanning service or plaintext secret cache.
- Published runs, draft test runs and single-step previews can save values.
  Pins keep their existing behavior: a pinned step is not called and therefore
  does not write values. New replay runs build their own values through execution.
  Recovery copies the source run's bounded business metadata when accepting its
  reused prefix, in the same transaction, before new steps can overwrite it.
- Retain values with execution details: ordinary runs use the shared thirty-day
  detail policy, draft tests the shared seven-day policy, previews their own
  expiry. Existing retention removes them before clearing details; owner deletion
  and workspace purge remove them too. No duplicate duration constants.
- Add one exact, case-sensitive key/value filter to Runs, combinable with current
  workflow, status and time filters. Require both fields together; an empty value
  is a valid exact search. Keep cursor paging and the shared test-run exclusion.
  Searches with run values bind a SHA-256 digest of the entire filter combination,
  keeping maximum Unicode filters within the existing cursor ceiling. Existing
  searches keep their legacy cursor encoding. Run detail shows a compact labelled list using existing Weft fields and copy
  controls; no new polling or request per list row.
- No new export/import behavior: workflow structure includes the ordinary step
  and mappings, while recorded run values never enter portable workflow files,
  templates or promotion. No custom-data expressions, arbitrary search, billing,
  new role, service, dependency, CI job or ADR.

## Structure and delivery

One PR. The initial move-only commit relocates existing object-mapping helpers
and execution-fence checks to their shared owners; the implementation reuses them.

| Owner | Change |
| --- | --- |
| `node-sdk/run-values` | Shared bounded input and capability contract |
| `nodes-core/data/run-values`, node-catalog | Registered step, safe executor, portable registration |
| `database/schema/runs/values.ts`, `runs/values/` | One RLS table, workspace/execution foreign keys, unique owner/key indexes and exact workspace/key/value index; transactional reads/upserts |
| `database/lifecycle`, recovery admission | Existing retention/purge integration and bounded recovery copy |
| `worker/attempts` | Scope/fence-bound persistence capability and existing redaction |
| contracts, `api/workflow-runs` | Existing run-list filter and detail projection, generated OpenAPI |
| `web/workflow-editor`, `web/workflow-runs` | Normal mapping rows, exact filter and run-detail values; current state owners |
| `docs/guides/run-values.md` | Business examples, visibility, bounds and retention |

Generate the migration from Drizzle, add the existing RLS/grant pattern, update
readiness and prove a populated upgrade. Table rows have exactly one run or
preview owner; their composite workspace foreign keys prevent crossing tenants.
Keep all database checkouts short and all durable rules in TypeScript.

## Qualification and status

Passed locally: shared input boundaries; core execution; credential field/text
redaction (including a 255-character credential-bearing value); real HTTP echo
redaction; concurrent ten-key cap and atomic replacement; stale fence/workspace
refusal; preview expiry; retained/test/recovery metadata; retention and workspace
purge; populated migration upgrade and forced RLS; exact filtering alongside
existing filters and excluding tests; cursor binding including empty/max text.
The existing data-table preview/record integration regressions pass after sharing
the execution fence.

A real browser registers an account, authors and publishes the step, runs it on
the real API/worker, reads the saved value and proves case-sensitive lookup.
Twelve focused mocked journeys cover editor/filter/detail in both themes at
375/990/1440 px; all twenty run-history journeys pass. Rendered screenshots were
inspected. React Doctor changed-file scan reports 98/100 with no findings.
Architecture, schema ownership (129 tables), dependency and generated-contract
checks pass. Full unskipped pre-push and CI remain required before merge.
