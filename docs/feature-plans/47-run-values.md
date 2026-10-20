# F47 — Run values

Status: owner-approved scope; plan reconciled with main on 2026-10-21. Implementation pending.

## Outcome and decisions

Save a small amount of plain business metadata, such as `orderId = A-1042`,
then find the execution by that exact pair. Follow
[n8n custom execution data](https://docs.n8n.io/build/understand-workflows/understand-executions/customize-executions-data):
text keys up to 50 characters, text values up to 255 and at most ten pairs.
Use the existing run/preview execution and retention owners, not another store
or execution mechanism.

- Add **Save run values** (`core.run_values@1`), an internal safe-to-repeat data
  step. Normal mappings provide one to ten key/value pairs. Keys use ASCII
  letters, digits, underscore, dot and hyphen, beginning with a letter or digit.
  Values are strings, including empty text; preserve case and whitespace.
  Invalid text, NUL and unpaired surrogates fail clearly at the step boundary.
  No implicit conversion, truncation, secret fields or arbitrary expressions
  beyond the existing mapping language.
- The ten-key bound applies to the entire execution, including multiple steps,
  loop iterations and parallel branches. Duplicate keys in one invocation use
  the last pair. Later committed writes replace earlier values. Serialize on
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
  Run detail shows a compact labelled list using existing Weft fields and copy
  controls; no new polling or request per list row.
- No new export/import behavior: workflow structure includes the ordinary step
  and mappings, while recorded run values never enter portable workflow files,
  templates or promotion. No custom-data expressions, arbitrary search, billing,
  new role, service, dependency, CI job or ADR.

## Structure and delivery

One PR, with a separate move-only commit only if an existing module must move.

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

Pending: boundary/duplicate/empty-text tests; concurrent ten-key cap and last-write
behavior; stale-fence and workspace refusal; preview/test/recovery ownership;
retention/purge; exact indexed filter composed with existing filters and excluding
tests; real worker → API → browser journey, credential echo redaction, keyboard
and light/dark phone/pane/desktop checks. Run project checks, full pre-push,
React Doctor and existing CI, then update only this status and F47's roadmap row.
