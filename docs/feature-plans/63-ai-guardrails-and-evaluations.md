# F63 — AI Guardrails and evaluations

Status: designed. Follows [F62](62-ai-authoring-assistant.md) and closes the
current [F22](22-ai-assistance-and-ai-nodes.md) track.

## Outcome and usage

Add **Guardrails** before inference, before a sensitive downstream action
or after a model output. Map the text, choose checks and connect **Pass**
and **Fail**. Route Fail to human review or a safe response. Inspect which
check caused the decision through existing authorized run diagnostics.
Operators select which data may be inspected by an external model and
configure the F56 connection only for optional model checks.

To evaluate a workflow, create a workspace data table with case inputs,
expected outcomes and optional labels. In workflow tests, select the table,
map case columns and choose existing output expectations, including a branch selector field. Start a
bounded evaluation of a selected version and inspect per-case results
and aggregate scores. Operators configure ordinary test capacity and table
access and use test-safe workflow bindings, including synthetic fixture data.

## Settings and execution

- Register `ai.guardrails@1` in the AI module. The deterministic tier
  checks bounded text with built-in PII patterns, explicit prohibited
  terms and recognizable injection markers. Use bounded literal matching
  and vetted patterns. User-supplied regex and execution of policy code are
  out of scope. A finding selects Fail immediately, before any model call.
  Keep only safe reason categories in diagnostics. A Pass says the
  configured checks found nothing.
- An optional model tier handles ambiguous injection signals or
  operator-specified text policy. Disclose the input and policy sent to the
  chosen provider. Run F56 structured validation and repair with a closed
  verdict/reason schema and no executable tools. A valid rejection routes
  Fail. Provider or validation failure fails the step, stopping normal
  downstream dispatch. PII covered by the enabled deterministic rules is
  blocked before transfer. Guardrails complement existing permissions and
  approvals, which still apply to every action.
- Return the existing `{ selectedPort }` branch envelope with fixed
  `pass` and `fail` ports. Map original inputs from their source. Reuse
  the branch, join and pin handling exercised by F59. Keep off-provider
  runs operational without a model connection.
- Reuse F02's suite execution and expectations, with F14 as a bounded case
  source. Resolve table permission and snapshot a deterministically ordered
  selection and existing suite expectations at test admission. Persist
  those evaluated inputs and workflow-version provenance under existing
  suite retention. Score each matching assertion as one, each miss as
  zero, and show the fraction passed with explicit denominator, failed
  runs and per-case details. Mark infra failure or cancellation incomplete
  and exclude those cases from completed scores. Run the same engine, test
  credential policy and capacity controls. Reject workflows with effectful
  steps or unknown effects for table batches, including nested calls.
  Evaluations require every Call to have an F02 output pin, reuse that
  pin in every case, and never admit a child run.
- Deterministic scoring is useful for routing and extraction within the
  track, and adding it later can reuse the same suite. Ship it now for
  repeatable acceptance. A dedicated evaluation scheduler, production
  sampling, model judges and a metric registry would be straightforward to
  add around case inputs and results later. There is no established
  year-one requirement. Defer them along with dashboards across runs.

## Codebase structure

Put Guardrails settings and execution under
`packages/integrations/src/ai/guardrails/` and share the browser-safe
branch declaration and engine observation path from F59. Use existing
worker connection and capability composition for the optional model check.
Reuse authorized row reads from `packages/core/src/data-tables/` inside
the admission transaction in `core/src/previews/suites/`.
Keep comparisons and suite report math beside the existing expectations
in `packages/workflow-model/src/authoring/test-suites/`. Extend existing
suite contracts, tests UI and run inspector. No new role, package entry
point or scheduler.

## Implementation slices

1. **Deterministic Guardrails.** Ship Pass/Fail routing and safe reasons
   with no provider dependency. Use fixture text and real editor/worker.
   No owner account.
2. **Optional model checks.** Ship injection and policy verdicts and
   disclosure with a fake provider through the real transport. No owner
   account.
3. **Table-backed evaluations.** Ship bounded suite import, execution and
   scoring against an isolated data table and test workflow. No owner
   account.

## Tests that prove it

Verify deterministic detection routes Fail and issues no model request.
Check legitimate text, category-specific findings, invalid verdict/repair,
timeout, budget and credential rejection. Observe both branches in a
published run. Evaluate a known mix of matching, mismatching and cancelled
cases and reconcile the displayed counts. Change the table after admission
and prove the snapshot governs the suite. Check table isolation, case caps,
retention and rejection of unsafe workflows before the first case runs.
