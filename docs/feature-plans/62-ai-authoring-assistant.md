# F62 — AI authoring assistant

Delivered in [#861](https://github.com/vigani1/pertexo/pull/861),
[#866](https://github.com/vigani1/pertexo/pull/866) and
[#883](https://github.com/vigani1/pertexo/pull/883). Part of
[F22](22-ai-assistance-and-ai-nodes.md).

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
sends the request, draft structure, disclosed step settings and input mappings,
and relevant catalog definitions.
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
  connection and secret-bearing settings. Preserve those values server-side
  on edits. Withhold unknown config names. Safe explanation metadata follows current run-read
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
  model alongside the original masked draft. Include the previous candidate
  only when it can be projected without the refused values. The
  assistant has at most two correction rounds within the same request limits.
  Report the rounds used with the final proposal.
  No new persisted proposal format, patch language or ADR.
- The assistant may return an explanation or an inspected proposal. It has
  no tool for saving, publishing, running, provisioning credentials or
  calling workflow tools. No shared chat history in this delivery.

- Record bounded model usage once per explanation or proposal as
  `assistant.model` against its run or workflow, summing all proposal rounds.
  It follows the same retention window as preview usage.

## Step settings disclosed to the model

A built-in registration lists its top-level config and input fields. Show the
settings and mappings that shape workflow logic or data. Mask request material
commonly used for credentials, including HTTP headers, query parameters, bodies,
webhook authentication, and secret-typed fields. Always mask connections and
approval audiences, including audiences inside Agent tool settings. Classify
open input schemas explicitly. Saved HTTP addresses
with query strings or embedded credentials stay protected as a whole. A
declared masked field keeps its name and a placeholder. Undeclared field names
and definitions without a disclosure use an opaque placeholder for the record.

The assistant can edit visible fields on existing steps. It must carry forward
each placeholder exactly and leave absent protected fields unset. Before applying
a proposal, review the before and after values for changed settings and mappings.

| Definition | Visible settings | Visible input mappings | Masked settings and mappings |
| --- | --- | --- | --- |
| `ai.agent` 1, 2 | `model`, `timeoutMillis` | `prompt`, `input`, `toolSchema`, `history` | `config.tool` |
| `ai.agent` 3 | `model`, `timeoutMillis` | `prompt`, `input`, `history`, `tools` | `config.tools` |
| `ai.classify` 1 | `model`, `timeoutMillis`, `maxOutputTokens`, `categories` | `text` | — |
| `ai.guardrails` 1 | `checks` | `text` | — |
| `ai.model` 1 | `model`, `timeoutMillis`, `maxOutputTokens`, `mode`, `outputSchema` | `prompt` | — |
| `core.approval` 1 | `title`, `instructions`, `expiresAfterSeconds`, `onExpiry`, `allowStarterToDecide` | `details` | `audience` |
| `core.batch` 1, 2 | `size` | `items` | — |
| `core.call` 1 | `target` | `input` | — |
| `core.code` 1 | `language`, `code`, `timeoutSeconds` | Named mappings | — |
| `core.concat` 1, 2 | — | `items`, `otherItems` | — |
| `core.condition` 1, 2 | — | `condition` | — |
| `core.create_file` 1 | `format`, `inputMode`, `delimiter`, `columns`, `sheetName` | `data`, `pages` | — |
| `core.crypto` 1 | `operation`, `algorithm`, `encoding`, `length` | `value` | — |
| `core.date` 1, 2 | `operation`, `format`, `timeZone`, `unit` | `value`, `amount` | — |
| `core.filter` 1, 2 | `path`, `operator` | `items`, `value` | — |
| `core.foreach` 1 | — | `items` | — |
| `core.form` 1 | `coordination`, `title`, `instructions`, `thankYouMessage`, `redirectUrl`, `fields` | `values`, `submittedBy`, `submittedAt` | — |
| `core.hmac` 1 | `algorithm`, `encoding` | `value` | — |
| `core.html` 1 | `operation`, `selector`, `limit`, `attribute` | `value` | — |
| `core.manual` 1 | — | Named mappings | — |
| `core.merge` 1, 2 | `parallelNodeId`, `policy` | `ledger`, `selectedBranchIds` | — |
| `core.number` 1, 2 | `operation`, `locale`, `grouping`, `minimumFractionDigits`, `maximumFractionDigits`, `currency` | `value` | — |
| `core.parallel` 1 | `branches`, `maxConcurrency` | — | — |
| `core.read_file` 1 | `format`, `outputMode`, `delimiter`, `convertValues`, `sheet`, `headerRow` | `file` | — |
| `core.request_input` 1 | `coordination`, `title`, `instructions`, `fields`, `expiresAfterSeconds`, `onExpiry` | `details`, `prefill` | `audience` |
| `core.respond_webhook` 1 | `bodyType`, `textContentType` | `statusCode` | `headers`, `body` |
| `core.run_values` 1 | — | `values` | — |
| `core.schedule` 1 | `kind`, `expression`, `timezone`, `misfirePolicy`, `intervalMinutes` | `triggerId`, `nodeId`, `scheduledAt` | — |
| `core.set` 1, 2 | — | Named mappings | — |
| `core.sort` 1, 2 | `path`, `valueType`, `direction`, `missing` | `items` | — |
| `core.summarize` 1, 2 | `valuePath`, `groupBy`, `missing` | `items` | — |
| `core.switch` 1, 2 | `cases` | `value` | — |
| `core.table_delete` 1 | `table`, `columnBindings` | `query` | — |
| `core.table_find` 2 | `table`, `columnBindings`, `tableId` | `query` | — |
| `core.table_find` 1 | `table`, `columnBindings` | `query` | — |
| `core.table_insert` 1 | `table`, `columnBindings` | `values` | — |
| `core.table_update` 1 | `table`, `columnBindings` | `query`, `values` | — |
| `core.table_upsert` 1 | `table`, `columnBindings` | `values` | — |
| `core.take` 1, 2 | `count` | `items` | — |
| `core.terminate` 1 | — | Named mappings | — |
| `core.text` 1, 2 | `operation`, `all`, `length`, `ellipsis` | `value`, `search`, `replacement`, `delimiter` | — |
| `core.unique` 1, 2 | `path`, `missing` | `items` | — |
| `core.validate` 1, 2 | `rules` | Named mappings | — |
| `core.wait` 1 | `durationSeconds`, `mode`, `timeoutSeconds` | Named mappings | `authentication` |
| `core.webhook` 1 | `coordination`, `runInput`, `responseMode`, `responseWaitSeconds` | — | Other named mappings |
| `core.workflow_error` 1 | — | `workflow`, `run`, `failedStep`, `error` | — |
| `core.xml` 1 | `operation` | `value` | — |
| `database.execute` 1 | `timeoutMillis`, `maxRows`, `operation`, `sql`, `schema`, `table`, `key`, `keys` | `parameters`, `rows` | — |
| `database.poll` 1 | `schema`, `table`, `orderingColumn`, `keyColumn`, `intervalMinutes`, `mode` | `triggerId`, `nodeId`, `item` | — |
| `email.send_notification` 1 | `timeoutMillis` | `subject`, `text`, `attachments` | `toEmail` |
| `http.poll` 1 | `intervalMinutes`, `itemsPath`, `itemKeyPath`, `url` (address only) | `triggerId`, `nodeId`, `item` | — |
| `http.request` 1 | `method`, `timeoutMillis`, `maxRedirects`, `maxResponseBytes`, `inlineResponseBytes`, `pagination`, `returnErrorResponses`, `url` (address only) | — | `headers`, `multipart`, `body`, Other named mappings |
| `mcp.call_tool` 1 | `toolName`, `toolInputSchema` | — | Other named mappings |
| `slack.send_message` 1 | `timeoutMillis` | `channelId`, `text` | — |

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

## Evaluation

The product browser journey includes a scripted catalog recovery and checks
both outcomes on the published workflow. The opt-in evaluation grades eight
cases. It checks new workflows, routing, renaming, schedule and mapping
changes, URL edits that preserve a saved header, and refusal to change protected
settings. The two HTTP edits keep an unpublished draft so the evaluation never
sends a workflow request. The refusal case checks both the saved draft and
every outbound model request.

Start a local OpenAI-compatible endpoint and use the normal owned browser test
environment. Run just the evaluation spec, three times per case:

```bash
PERTEXO_AUTHORING_EVAL_ORIGIN=http://127.0.0.1:8000 \
PERTEXO_AUTHORING_EVAL_MODEL=your-local-model \
EDITOR_BROWSER_SPEC=draft-evaluation.spec.ts EDITOR_BROWSER_REPEAT_EACH=3 \
node infrastructure/testing/run-browser-journeys.mjs 1 product
```

Each case attaches its outcome, request bytes, correction rounds, latency and
reported usage to the Playwright results. For a local fixture check, set
`PERTEXO_AUTHORING_EVAL_SCRIPTED=true` in place of the origin and model to run
the four edit cases with fixed replies.

See the proposal review on a phone in [light mode](evidence/f62/draft-settings-light.png)
and [dark mode](evidence/f62/draft-settings-dark.png).
