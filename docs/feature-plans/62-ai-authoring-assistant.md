# F62 — AI authoring assistant

Status: designed. Follows [F61](61-ai-agent-step.md) and precedes
[F63](63-ai-guardrails-and-evaluations.md).

## Outcome and usage

Open the assistant from the editor, describe a workflow or change, and
review a proposed draft diff. Apply it through the ordinary draft save
and publish through the ordinary review controls. From a failed run,
request an explanation grounded in the run's accessible step, safe
failure code and definition version. Use the explanation to navigate to
the affected step or request a draft change.

A workspace administrator enables the assistant by selecting an approved
workspace AI connection and model. The user must have permission to use
that connection and to read the requested workflow or run. Before sending,
the UI identifies the endpoint and the context categories transferred.
Explain sends safe run metadata and summaries by default. Draft generation
sends the request, filtered draft context and relevant catalog definitions.
An operator sets provider limits, address policy and retention expectations.

## Settings and execution

- Draft generation uses the AI module's structured response path and F56
  secure dispatch. Rank relevant editor definitions locally, including retained
  definitions that the current draft uses. Consider descriptions as well as
  explicit step names so a request can mix both. Send a bounded projection of
  catalog schemas and ports alongside the masked draft and user request. When
  details are missing the model can request one read-only catalog search. Use
  the same catalog ranking and placement rules, prioritize newly found exact
  definitions, and send at most three new entries within the same catalog,
  prompt, token, and deadline budgets. Model output, catalog content, and user
  input are data. Failed-run explanations keep their own request deadline and
  workspace budgets.
- Project only the context needed for the task. Exclude credentials,
  connection secret material, authorization headers, raw provider failure
  bodies and run payloads. Use typed references or placeholders for
  connection and secret-bearing settings, omitting sensitive workflow
  fields and unknown config from the projection. Preserve such fields
  server-side on edits. Safe explanation metadata follows current run-read
  permission, and opaque IDs in answers resolve only to authorized links.
  Never pass credentials in messages or tool arguments. The runtime
  attaches its credential only to authorized provider transport.
- The structured response returns a candidate in the existing workflow draft
  graph shape against the existing base revision. Materialize server-held
  fields through the authorized draft and reject changes to masked values.
  Run normal graph admission and publication validation in read-only
  preview against that candidate. Return the existing validation issues
  and draft representation for the current diff UI. Save requires a
  human's action, the normal expected revision and server-side revalidation.
  Stale saves fail and can be regenerated against the new draft. Publication
  retains its own validation and review. Unresolved human-supplied settings
  appear as issues. Use field defaults for new steps in a selected setup.
  Whole editor presets, such as a blank starter case, require an explicit
  choice in a proposal. Feed correctable issues from graph checks back to the
  model alongside its previous candidate and the original masked draft. The
  assistant has at most two correction rounds within the same request limits.
  Report the rounds used with the final proposal.
  No new persisted proposal format, patch language or ADR.
- The assistant may return an explanation or an inspected proposal. It has
  no tool for saving, publishing, running, provisioning credentials or
  calling workflow tools. No shared chat history in this delivery.

- Record bounded model usage once per explanation or proposal as
  `assistant.model` against its run or workflow, summing all proposal rounds.
  It follows the same retention window as preview usage.

## Codebase structure

Add an API service and route under `apps/api/src/workflow-authoring/`.
Use `apps/api/src/catalog/` for search and details and existing authorized
run reads for explanations. Extend the read-only authoring validation seam
under `packages/core/src/authoring/` to inspect a candidate using the same
compiler as Validate draft and publish. Maintain workspace selection through
the current connection and workspace settings owners. Put request and
response schemas and route declarations in `packages/contracts`. Keep
the diff and confirmation in the existing web draft/editor features and
the explanation in the run inspector. Use existing entry points and roles.

## Implementation slices

1. **Explain a failed run.** Ship configured model selection, transfer
   disclosure and a real failed-run explanation grounded in safe history.
   Exercise local fake inference and the real run inspector. No owner account.
2. **Propose and apply a draft change.** Ship catalog context and a validated
   draft diff for empty and existing drafts, plus normal human save and
   publication. Prove the full editor path with local inference. No owner
   account.

## Tests that prove it

Check unauthorized run and connection, stale draft revision, unsupported
manifest versions, malformed graph, and a graph that saves as a draft
but fails publication. Use a sentinel secret in credential storage and
masked step settings, and inspect actual outbound requests and retained
diagnostics. Confirm prompt text and fake tool replies cannot publish,
run or overwrite masked settings, and that applying a proposal and
publishing are separate user actions.

With real models, evaluate ordinary requests for new drafts, routing, and
edits to existing drafts. Grade the actual conditions, mappings, retained
fields, and runtime behavior. Track request size, correction rounds and
latency alongside pass rates for each model and provider tested.

The product browser journey includes a scripted catalog recovery and checks
both outcomes on the published workflow. To run the real-model cases in the
same owned fixture, start a local OpenAI-compatible model endpoint and set
`PERTEXO_AUTHORING_EVAL_ORIGIN` to its `http://127.0.0.1` origin and
`PERTEXO_AUTHORING_EVAL_MODEL` to its model identifier. Run the product journey
with `node infrastructure/testing/run-browser-journeys.mjs 1 product` using
the normal local browser test environment. The evaluation attaches proposal
outcomes, request sizes, timing and reported usage to the Playwright results.
