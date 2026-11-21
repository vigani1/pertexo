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

- The API service orchestrates a bounded request through the AI module's
  `ModelClient`, F56 secure dispatch and the bounded proposal support from
  F61. Its tools search the visible catalog, fetch versioned step details
  and propose graph edits. Filter availability by the same catalog and
  workspace rules as the editor. Bound tool calls, response size, tokens,
  elapsed time and concurrent requests. Treat tool output, labels, user
  input and model text as data.
- Project only the context needed for the task. Exclude credentials,
  connection secret material, authorization headers, raw provider failure
  bodies and run payloads. Use typed references or placeholders for
  connection and secret-bearing settings, omitting sensitive workflow
  fields and unknown config from the projection. Preserve such fields
  server-side on edits. Safe explanation metadata follows current run-read
  permission, and opaque IDs in answers resolve only to authorized links.
  Never pass credentials in messages or tool arguments. The runtime
  attaches its credential only to authorized provider transport.
- The proposal tool returns a candidate in the existing workflow draft
  graph shape against the existing base revision. Materialize server-held
  fields through the authorized draft and reject changes to masked values.
  Run normal graph admission and publication validation in read-only
  preview against that candidate. Return the existing validation issues
  and draft representation for the current diff UI. Save requires a
  human's action, the normal expected revision and server-side revalidation.
  Stale saves fail and can be regenerated against the new draft. Publication
  retains its own validation and review. Unresolved human-supplied settings
  appear as issues. No new persisted proposal format, patch language or ADR.
- The assistant may return an explanation or an inspected proposal. It has
  no tool for saving, publishing, running, provisioning credentials or
  calling workflow tools. No shared chat history in this delivery.

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
2. **Propose and apply a draft change.** Ship catalog tools and validated
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
