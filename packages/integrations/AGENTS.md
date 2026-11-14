# @pertexo/integrations

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The steps that talk to outside services (HTTP request, Slack send message,
email send notification) and the provider plumbing they share: outcome and
retry policy, OAuth2 consent and token endpoints, webhook signature checks
and the dispatch fence. Built on the `node-sdk` contract; `node-catalog`
lists the steps and the worker and API run the server parts.

Two entries. `@pertexo/integrations` is safe in the browser: definitions,
schemas, placeholders and failure codes. `@pertexo/integrations/server`
adds executors, clients and policies. It depends on `@pertexo/contracts`,
`@pertexo/node-sdk` and `@pertexo/workflow-model`. It never opens a network
connection itself: every call goes through the `ProviderHttpClient` the
caller hands in (the secure client in `@pertexo/secrets/server`). It never
reads the environment.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `http/`: content types, the outcome policy, `Retry-After` parsing and its
  failures (`retry-after.ts`, `retry-after.errors.ts`), and the
  HTTP request step (`request/`, with `execution/`, `multipart/` and
  `pagination/`).
- `slack/`: the Slack client, connection health, rejection policy and the
  send-message step (`send-message/`).
- `email/`: the mail client, SMTP and system mail, attachments, and the
  send-notification step (`send-notification/`).
- `oauth2/`: consent, endpoints, settings, the token endpoint and
  `OAuth2TokenFailure`.
- `providers/`: the provider HTTP client interface, provider errors,
  the dispatch fence, `withProviderCredential`
  (`provider-credential.ts`) and `registerProviderExecutor` with its
  `ExecutorTelemetry` (`provider-executor.ts`).
- `webhooks/`: inbound webhook signature verification.

Each step is `<provider>/<step>/<step>.definition.ts`, `.executor.ts`,
`.schemas.ts` and `.errors.ts`, the shape `nodes-core` uses.

## Where new code goes

- A new provider step: `<provider>/<step>/` with those four files, listed in
  `node-catalog`; provider-wide code (client, health, rejection policy) sits
  in `<provider>/`.
- A provider failure: built with `providerFailure` (`providers/provider.errors.ts`)
  so it carries the closed codes and retry facts every step reports.

## Defaults and config

- No environment. Step bounds live in each step's `.schemas.ts`
  (`HTTP_REQUEST_LIMITS`,
  `HTTP_PAGINATION_LIMITS`, `EMAIL_SEND_NOTIFICATION_LIMITS`,
  `SLACK_SEND_MESSAGE_LIMITS`); the provider steps' timeout is
  `PROVIDER_STEP_TIMEOUT` (`providers/provider-timeout.ts`). Shared bounds
  come from their owners: email addresses from workflow-model's
  `EMAIL_ADDRESS_LIMITS`, header bounds from contracts'
  `HTTP_HEADER_LIMITS`, retry waits from node-sdk's
  `MAXIMUM_RETRY_DELAY_MILLIS`.
- HTTP statuses are written where HTTP code writes them (compared to a
  `status`, or a `status` value); the limits check allows exactly those.

## Rules

- Every provider step opens its credential through `withProviderCredential`,
  which checks the resolved identity, parses the secret and always zeroes it,
  and registers through `registerProviderExecutor`, which applies the app's
  telemetry.
- Provider responses are untrusted: steps keep only redacted, bounded
  excerpts and classify failures through `http/outcome-policy.ts`.
- `Retry-After` is read only by `parseRetryAfterMillis` (`http/retry-after.ts`).

## Exceptions

- Generic throws that stay are assertions: `http/outcome-policy.ts` (an
  unreachable error code), `http/request/execution/oauth2-renewal.ts` (a
  renewed request asking to repeat again), `http/request/pagination/execute.ts`
  (a finished loop without its result) and the constructor guards in
  `request.errors.ts` and `pagination.errors.ts`.

## What guards it

- `pnpm --filter @pertexo/integrations test`: each step against fake
  clients, outcome and retry policy, OAuth2, multipart and pagination, and
  webhook signatures.
- The worker's `test/integrations/` runs the HTTP step through real guards.
- `pnpm check`: package structure, naming, browser-entry and environment
  checks.
