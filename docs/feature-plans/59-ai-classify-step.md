# F59 — AI Classify step

Delivered in [#850](https://github.com/vigani1/pertexo/pull/850).
Part of [F22](22-ai-assistance-and-ai-nodes.md).

## Outcome and usage

Add **Classify** to a workflow, select a workspace AI connection and a model,
map text, and name and describe each category. Connect each category and
**Other** to its downstream steps. For example, route a support message to
Billing, Access or Other. Downstream steps can still map the original message.
Operators configure the F56 connection, address policy and provider spend
controls. The editor discloses the text and category definitions sent to the
provider. A small model that passes the workflow's cases is a good routing
default. The user chooses its identifier.

## Settings and execution

- Register `ai.classify@1` in the existing AI module. Classify selects one
  output port and participates in branch scoping, joins and recovery. The
  two `ai.model@1` modes return values on the same path. Making routing a
  model mode would couple their graph contracts and complicate retained
  versions. Extract followed by Switch would duplicate category mapping and
  expose an unnecessary intermediate value. Inference still has one
  implementation.
- Follow Switch's manifest and configured-port pattern. Use a bounded slot
  set and save the slot ID with each category. Derive the visible ports from
  occupied slots plus the reserved `other` port. Renaming or reordering
  preserves the slot and its edges. Removing a category removes its port and
  requires the editor to remove or rewire affected edges in the same draft
  change. Reject dangling edges in graph admission. Require at least one
  category, unique slot IDs and case-insensitively unique trimmed labels,
  and nonempty bounded descriptions.
- Build the F56 schema subset object with a required `selectedPort` enum of
  configured IDs plus `other` and no extra keys. Give the model the text,
  category descriptions and IDs, and direct it to choose Other if none
  fits. Only an explicit, validated Other selection routes to that port.
  Malformed answers get the existing single repair. An exhausted repair,
  refusal, timeout or unavailable model follows F56's failure policy.
- Output the existing `{ selectedPort }` envelope. Reuse model limits,
  secure connection dispatch, retry classification, usage diagnostics, and
  validated pin substitution. A fresh replay can choose a different branch.

## Codebase structure

Keep the step registration and executor under
`packages/integrations/src/ai/classify/`. Move the F56 structured-output
admission and repair to their shared owner under `ai/` when Classify becomes
their second caller. Put the browser-safe category config and port derivation
alongside the existing branch definitions in
`packages/workflow-model/src/flow/control-nodes/`. Reuse the engine's
configured-port, selection observation and pin validation paths. The web
editor uses that same port derivation for its category form and labels.
Keep the existing AI registration and package entry points.

## Implementation slices

1. **Classify and route.** Ship the catalog, branch compilation, executor,
   category editor, preview and inspector together. Use a fake model with
   the real worker and editor. No owner account.

## Tests that prove it

Verify all category routes and Other after publish, including a join and
coordinator recovery. Rename and reorder categories and check that saved edges
keep their meaning. Delete a category and reject an obsolete edge or pin.
Send an unknown label, an array of labels and extra keys through the fake
provider. Prove that repair succeeds once, exhaustion fails without a branch,
and an existing valid pin makes no model call.
