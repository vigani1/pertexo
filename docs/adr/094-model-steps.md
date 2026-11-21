# ADR 094: Model steps use typed connections and validate structured output

- **Status:** accepted
- **Date:** 2026-11-21
- **Related:** [ADR 080](080-draft-step-samples.md), [ADR 091](091-core-layer.md),
  [ADR 095](095-integration-modules.md)
- **Feature:** [F56](../feature-plans/56-ai-model-step.md), first delivery from [F22](../feature-plans/22-ai-assistance-and-ai-nodes.md)

## Context

A workflow needs to turn text into data that downstream steps can use. Model
protocols differ in how they request JSON and report usage. A provider can
return malformed or schema-invalid data even when it promises structured output.
An inference call can also incur charges and return a different result when
repeated.

## Decision

**One inference port in the AI integration module.** The step and its
`ModelClient` live under `packages/integrations/src/ai/`. Register the AI module
with one line in `packages/node-catalog/src/integration-modules.ts` under ADR 095.
A single `ModelClient` accepts a bounded text request, model, output mode,
deadline and dispatch guard. It returns a normalized completion or a
classified failure. Use OpenAI-compatible Chat Completions for OpenAI,
OpenRouter, Ollama and vLLM, and Messages for Anthropic.
Application composition injects the secure outbound HTTP client from
`@pertexo/secrets/server`, as in ADR 091. Every request obeys HTTP Request's
address policy, including connection tests and repairs. Local Ollama requires an
operator-allowed private network. Redirects are disabled for model calls.
Streaming, multimodal input, embeddings, other provider protocols, authoring
assistance and agent tools are deferred.

**One typed workflow connection slot.** The API-key login for provider `ai`
and auth key `model_api_key` is a connection definition in the AI module's
`connections.definition.ts`. Its encrypted credential is discriminated by
endpoint variant and has a secret API key and an optional base URL field.
Self-hosted variants require the URL. The variant selects an ADR 095 auth
recipe: bearer for OpenAI-compatible endpoints and a named `x-api-key` header
for Anthropic. The connection runtime applies the recipe, and the model adapter
owns the protocol path. The registry admits the pair through the existing
contracts envelope and F57's open auth key constraint. The step stores a
connection reference and uses the existing connection authorization, rotation,
redaction and current-secret dispatch fence.

**Validate before publishing output.** Structured extraction takes a bounded
JSON Schema object from the step's versioned catalog configuration. Request
JSON with native structured output or a fixed output-only tool where the
endpoint supports it, and use a JSON-only prompt for endpoints with no such
mode. Pertexo parses and validates the returned JSON locally in every mode.
One repair call is allowed within the same attempt and deadline. If the
repaired value still fails, finish with `model.output_schema_invalid`. Only
validated JSON goes to downstream steps. The adapter's extraction tool, where
used, provides a return envelope and has no executable capability.

**Bound each attempt and retain usage with it.** Cap encoded input bytes,
output tokens per call, response bytes and the total time for inference and
repair. Record the model and provider-reported input and output tokens for
each completed attempt, including reported usage from rejected answers and
repairs. Keep unavailable usage distinct from a reported zero. Later workspace
enforcement can reserve tokens using the existing capacity counter pattern,
and there is no established workspace-wide quota requirement for the next
year in this self-hosted deployment. The first release records usage and
enforces per-attempt bounds. It adds neither billing nor workspace quotas.

**Engine retries remain engine retries.** Model inference is repeatable for
execution purposes because it cannot invoke tools or mutate a downstream
resource. Repeating it can incur another provider charge. Recommend engine
retry on provider 429, 5xx and timeout, using `parseRetryAfterMillis` through
the existing HTTP outcome policy and `decideRetry` for the attempt decision.
Shape repair is immediate and bounded within an attempt. Exhausted repair is
a terminal output failure.

**Model data follows run-data rules.** Pertexo sends the mapped prompt and, in
structured mode, the schema to the chosen provider. A repair can send the
provider's rejected answer back to that provider. Retained prompts and returned
output use existing run-data access, retention and redaction. Keep API keys
out of logs, error summaries and run data. Failed provider responses and
repair transcripts are transient.

**Samples and replay follow the existing execution paths.** An F02 test with
a current pin uses the saved output without a provider call. Unpinned tests
call the provider. A full run replay calls the model again using the
selected retained workflow version and replay inputs. Version pinning freezes
setup, and checkpoint recovery can reuse a result already committed by the
engine. Fresh inference can yield different output.

## Consequences

Downstream steps receive a stable output envelope and a value checked against
the saved schema. Adapters can change protocol behavior behind the same port.
Usage is evidence from received responses. A timeout or worker loss can leave
charges that Pertexo cannot observe. Operators manage provider retention and
spend through their chosen service and credentials.
