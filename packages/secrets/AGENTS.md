# @pertexo/secrets

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

Everything that holds or sends a secret: envelope encryption of connection
and webhook secrets (self-managed keys or AWS KMS), the application key ring
and stored key checks, sealed system mail and its delivery, signed callback
keys, and the one secure outbound HTTP client with credential redaction.
Node only (`@pertexo/secrets/server`). It depends on `database` (key and
mail rows), `contracts`, `node-sdk` and `workflow-model`; only applications
and `core` depend on it (ADR 091).

It never decides who may use a connection (`core` does), never logs a secret
and never returns a response body before redaction.

## Layout

- `src/server.ts`: the entry.
- `encryption/`: the connection-encryption config, the connection and AWS
  envelope runtimes and `encryption.errors.ts`; `envelopes/` the
  sealed formats and cipher; `keys/` key providers, the key ring, KMS client,
  stored keys and their verification.
- `mail/`: system mail config, sealing, the delivery store and repository,
  delivery with retries, and SMTP.
- `callbacks/`: signed callback keys and their verification.
- `outbound-http/`: the client (`secure.ts`), request parsing and errors;
  `execution/` routing, responses and cancellation; `redaction/` response
  and stream redaction; `transport/` the socket and address policy.

## Where new code goes

- A new sealed secret kind: a format in `encryption/envelopes/` built on
  `EnvelopeCipher`, with its associated data.
- A new key source: a provider in `encryption/keys/` implementing
  `EnvelopeKeyProvider`.
- A new outbound HTTP rule: in `outbound-http/execution/` or `transport/`,
  failing with a `SECURE_HTTP_ERROR_CODE`.
- A new mail purpose: `SystemMailPurpose` and its associated data.

## Defaults and config

- Environment: `encryption/connection-encryption-config.ts` (connection
  keys) and `mail/config.ts` (system mail). Each parses the environment the
  calling app's config hands it and returns a typed config; the runtimes only
  build from that config.
- Sizes and lengths: named constants at the top of the file that enforces
  them; the envelope format's sizes in `encryption/envelopes/envelope-format.ts`.

## Rules

- Every secret is sealed with associated data naming what it belongs to.
- Every outbound request goes through `SecureHttpClient`: pinned DNS, the
  address policy, bounded bodies and redaction of every credential spelling.
- Retired keys only open; only the current key seals.
- Errors live in `encryption/encryption.errors.ts`, `mail/mail.errors.ts`,
  `callbacks/callback.errors.ts` and `outbound-http/secure-http.errors.ts`.
  Outbound HTTP's internal rejections (`SecureHttpRejection`,
  `SecureHttpTransportError`) only ever reach a caller as the cause of one
  `SecureHttpError`.

## Exceptions

- The key inventory's cancellation is a plain `Error` named `AbortError`: pg
  and the pool recognise a cancellation by that standard name.

- `outbound-http/transport/address-policy.ts`, `redaction/decoded-body-view.ts`,
  `response-charset.ts` and `sensitive-representations.ts` parse formats, so
  their numbers are listed as not limits in
  `infrastructure/checks/validate-backend-limits.mjs`.

## What guards it

- `pnpm --filter @pertexo/secrets test`: envelopes, keys, mail, callbacks and
  the HTTP client (SSRF, redirects, redaction).
- `pnpm --filter @pertexo/secrets test:integration` needs PostgreSQL
  (`DATABASE_*_URL`): stored keys and mail deliveries.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
