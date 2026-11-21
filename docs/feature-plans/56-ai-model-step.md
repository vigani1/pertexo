# F56 — AI Model step

Status: proposed. Delivers slice 2 of [F22](22-ai-assistance-and-ai-nodes.md)
first. Decisions in [ADR 094](../adr/094-model-steps.md). F22's model budget
means the call and attempt bounds below. Authoring assistance and agent tools
have their own delivery slices.

## Outcome

Create an AI model connection in the workspace, choose the endpoint, and enter
the API key and any custom base URL. Add an AI Model step, select the connection,
enter a model identifier, and map the prompt from workflow data. Set the
maximum output tokens and timeout. The editor discloses the external data
transfer and that running without a pin may incur charges.

Offer **Generate text** and **Extract structured data** as modes of one
`ai.model@1` definition. Both use the same required connection slot, mapped
prompt, execution lifecycle and limits. The mode only changes the requested
output and its validation. Generate text returns `{ text }`. Extract
structured data adds a JSON Schema editor and returns `{ data }`, where
`data` is a schema-validated JSON object that downstream mappings can
traverse. The versioned manifest declares both envelopes. The saved schema
constrains `data`, while the first release uses the existing generic JSON
field picker for nested keys.

Reject invalid schema and missing settings before a live call. In the run
inspector distinguish denied address, rejected credential, unavailable or
unsupported model, truncation or refusal, provider timeout, rate limiting and
output that still fails validation after repair. Show reported token counts
and model with each attempt. A pin shows its existing provenance and carries
no inference usage record.

## Settings and execution

- Put the prompt in the mapped input so the config carries only model, mode,
  timeout, token limit and, for extraction, the output schema. Own the bounds
  alongside the versioned settings. Start with 64 KiB of encoded request
  body per call including a repair, 1,024 default and 4,096 maximum output
  tokens per call, a 30-second default and 60-second maximum attempt
  timeout, and a 128 KiB response cap. Respect a shorter worker deadline and
  cancellation. Return a specific input-limit failure before dispatch if the
  encoded body exceeds the cap.
- Accept a bounded local JSON Schema 2020-12 subset rooted at an object.
  Support properties, required keys, additionalProperties as a boolean,
  arrays with items, primitive types and enums. Cap schema JSON at 8 KiB
  and depth at 16. Reject unsupported keywords, refs and regex before
  compiling. Validate without coercion, defaults or property removal.
  Follow the Ajv 2020 precedent in `node-catalog/test/setup-schema.test.ts`.
  Use the same schema admission rule in the catalog registration and the
  prepared executor, with one implementation of the subset.
- Connection variants are OpenAI, OpenRouter, Ollama, vLLM and Anthropic.
  Cloud variants have a default versioned API base. Local variants require a
  base URL and accept a configured API key even when the server ignores it.
  Accept only HTTP(S) base URLs with no userinfo, query or fragment, and
  append a fixed protocol path while preserving the API base path. Use
  native JSON object mode for OpenAI, Ollama and vLLM, and a forced output-only
  tool for Anthropic. Use prompt JSON for OpenRouter in v1 so the step can use
  routes without native structured output. OpenAI-compatible requests include
  the schema in the prompt. Each variant requires a model that supports its
  configured method.
  [OpenAI JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs),
  [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility),
  [vLLM structured output](https://docs.vllm.ai/en/stable/features/structured_outputs/),
  [Anthropic tool choice](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
  [OpenRouter model support](https://openrouter.ai/docs/guides/features/structured-outputs).
- Use one request plus at most one repair per engine attempt. A repair sees
  the original task, schema and bounded rejected answer. Limit and validate
  the repair request like the first call. Use the same attempt signal and
  remaining deadline. Malformed JSON and schema-invalid candidates can be
  repaired. Provider refusals, truncation, auth errors and malformed provider
  envelopes surface as separate safe failures. A transient provider failure
  during repair returns to the engine retry path.
- Use the same provider dispatch binding for both calls. Check the current
  workspace connection and secret version before each call, while marking
  the runtime dispatch once. A later credential rotation can stop a repair.
  Discard raw provider errors and keep known credential values out of accepted
  output and diagnostics. If a candidate echoes the API key, fail with a safe
  code before retaining it or sending it back for repair.
- Store one optional usage record per attempt. Use the configured model
  identifier and input/output totals across responses with usage, including
  invalid answers and repairs. Indicate incomplete accounting when any
  dispatched call omits usable counts or has an unknown outcome. Missing
  counts stay unknown. A completion receiving no provider accounting can
  still report the model with unknown counts. Replayed completion writes
  reuse their receipt, and a lost worker can leave unrecorded provider usage.

## Implementation slices

1. **Typed connection and catalog.** Add the discriminated credential in
   `packages/contracts/src/schemas/connections/` beside
   `postgresCredentialSchema`. Extend `connectionCredentialSchema`, the
   provider/auth fields and create-request narrowing in `connections.ts`.
   Reuse current routes in `packages/contracts/src/routes/connections/management.ts`
   and generate OpenAPI through ADR 092. Extend `CONNECTION_AUTH_TYPE` in
   `workflow-model/src/authoring/connection-vocabulary.ts` and the connection
   constraints in `database/src/schema/connections.ts` with an additive
   migration, following `0006_allow_postgres_connections.sql`. Keep existing
   core connection management and encrypted secret versions. Add the config,
   input and output schemas and the manifest in
   `integrations/src/ai/model/` using `generateSchemaDocument` like
   `DATABASE_DEFINITION_REGISTRATION`. Prepare the registration and the
   `model_api_key` slot in `node-catalog/src/catalog.ts` and
   `platformPortableDefinitionPolicy`. Ship the registration with its executor.
2. **Provider adapters and execution.** Implement `ModelClient` and the two
   adapters under `integrations/src/ai/`. Inject `ProviderHttpClient` from
   `integrations/src/providers/http-client.ts` and read bounded responses with
   the same secure transport as `createHttpRequestExecutorRegistration`.
   Use `classifySecureHttpResponse` and `classifySecureHttpError` in
   `integrations/src/http/outcome-policy.ts` with the repeatable policy.
   Declare `retryClass: safe` in the manifest.
   Reuse its Retry-After ceiling behavior and the engine's
   `workflow-engine/src/attempt/retries.ts#decideRetry`. Translate model
   failures to `NodeExecutorFailure` with safe codes. Open the typed
   credential with the Database executor's scoped secret pattern from
   `integrations/src/database/execute/execute.executor.ts`. Extend
   `createProviderConnectionRuntimeFactory` and `assertSecretCurrent` in
   `apps/worker/src/providers/connections.ts`. Use
   `createProviderBeforeDispatch`, following the HTTP executor's
   `markingDispatchOnce` pattern for additional calls. Register the executor
   in `node-catalog/src/server.ts#createPlatformNodeRegistry` and inject the
   HTTP Request address policy through
   `apps/worker/src/attempts/delivery/node-attempt.runtime.ts` and
   `apps/worker/src/providers/node-registry.ts`. Worker previews use that
   registry too.
3. **Usage and connection tests.** Carry typed, bounded usage on attempt
   outcomes through `node-sdk/src/execution/` and
   `apps/worker/src/attempts/delivery/`, including
   `executorFailureCompletion`. Use a nullable usage field on `nodeAttempts`
   in `database/src/schema/runs/node-executions.ts`, with
   `saveAttemptCompletion` writing it under `completeNodeAttempt`'s existing
   fence and receipt. Follow the attempt diagnostics read through
   `core/src/runs/queries/history/details.repository.ts` and
   `contracts/src/schemas/execution/runs.ts` for the run inspector. Persist
   equivalent preview evidence via `core/src/previews/attempts/complete.ts`
   and expose it through `contracts/src/schemas/execution/node-testing.ts`.
   Keep both records under parent retention and purge. In
   `apps/api/src/connections/testing/test-connection.ts`, extend
   `TestConnectionService` with a typed model-connection test using a bounded
   models-list request on the same base and address policy. Report what that
   endpoint verifies. Actual inference compatibility is verified by Test step.
   Extend the existing test request and sealed credential decoder in
   `contracts/src/schemas/connections/connections.ts` and
   `apps/api/src/connections/testing/credentials.ts`. Supply the configured
   private-network policy and the existing test dispatch guard.
4. **Editor and integrated acceptance.** Follow
   `apps/web/src/features/connections/model/postgres-draft.ts` and
   `components/credential/postgres-fields.tsx` for connection creation, rotation
   and safe health messages. Register AI Model in
   `features/catalog/model/steps/registry.ts`. Reuse the editor's catalog
   settings and `SchemaField` in
   `features/workflow-editor/components/inspector/fields/schema.tsx` for the
   mode fields and JSON input. Use the existing Test step and sample controls.
   Show model error copy and usage in the existing inspector. Land
   schema/readers before exposing writes and editor controls. Enable only
   with the complete executor and compatible workers. If rollout is paused,
   keep readers and execution support for retained versions while stopping
   new admissions that use the step.

## Tests that prove it

Use a local fake provider server on an ephemeral port with routes for Chat
Completions, Messages and the connection probe. Exercise the real secure
transport, registry, attempt completion and run-history reads. Use an isolated
worker and database, and allow only the fake provider network in the fixture.

- Both APIs produce valid downstream JSON. Generate text returns the text
  envelope. Check the declared output mode, schema and token cap received at
  the fake server. Check default and custom base URL handling.
- Malformed or schema-invalid JSON followed by a valid repair succeeds with
  exactly two calls in one attempt. A second invalid output fails with
  `model.output_schema_invalid`, emits no downstream output and schedules no
  retry. Invalid configuration and over-limit input fail before dispatch.
- A 429 with Retry-After and a 5xx schedule engine retries. A delayed response
  triggers the attempt timeout. Check retry timing from persisted scheduling
  evidence. Verify a denied address or redirect produces no request to the
  rejected destination, including on a connection test.
- Use a sentinel key in fake error bodies and an echoed completion. Verify
  the key appears only in the authorized outbound request, and inspect logs,
  API errors, run values and history for leaks. Check a credential rotated
  before repair cannot be dispatched using the old key.
- Check model and token counts persisted for success, repair, failure and
  engine retry. Check missing usage, receipt replay without double-counting,
  and retention with the owning attempt.
- Extend the real editor journey beside
  `apps/web/e2e-live/editor/product/postgres.spec.ts`. Create and test the
  connection, configure extraction, run Test step and map a resulting field.
  Inspect usage on a published run. Pin the preview and prove F02 test
  substitution makes no call. Replay the published run and observe another
  inference. The journey uses the local fake and isolated services throughout.
