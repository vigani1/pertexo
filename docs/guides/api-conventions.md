# API conventions

What a client of the HTTP API can rely on. The [automation guide](automation.md) says how
to use it with a token; this page says what stays the same.

## What's stable

Routes that accept an API token are the public API, described by `GET /v1/openapi.json`,
which any OpenAPI viewer or client generator can read. Every other route under `/v1` serves
the web app and can change with it, so don't script against it.

On public routes:

- **Adding is always allowed:** new fields, new optional inputs, new statuses, new problem
  codes. Your client must ignore what it doesn't know.
- **Breaking changes go to `/v2`, with notice.** Removing or renaming a field, or a new
  required input, breaks. The old version keeps working through the notice period.
- **A stored format isn't the API.** Only what's documented here and in the reference is.

## Response compatibility

All HTTP JSON response decoders, including browser-session routes, discard unknown object members, including nested
projection metadata, and continue to validate known fields, bounds and required
values. Declared JSON/configuration maps preserve their contents. Requests and
queries reject unknown members; response tolerance never changes write validation. JSON response declarations must use the shared response-schema helper; the route type and recursive contract catalog check enforce this for new routes and alternate successes.

For this release, `graphDigest` and `listSummary` require explicit `include`
parameters because previously deployed response decoders rejected extra fields.
Default read and write responses preserve the previous release's shape. Use
`include=graphDigest` on draft/version reads, `include=listSummary` on workflow
lists, or `include=organization,listSummary` for an organized list. Existing
`include=organization` reads retain their previous shape. See the
[automation guide](automation.md#read-projections-and-decoder-compatibility).

## Methods and statuses

| Action | Request | Answer |
|---|---|---|
| Read | `GET` | 200 |
| Create | `POST` | 201 with the resource, or 202 when the work happens later |
| Replace or edit | `PUT`, or `PATCH` for a partial change | 200 with the resource |
| Remove, with nothing to send | `DELETE` | 204, or 200 with the result |
| Remove, carrying a revision or a reason | `POST .../remove`, `.../delete` or `.../revoke` | 200 with the result, because a `DELETE` body doesn't survive every proxy |
| A named action: publish, cancel, rotate | `POST .../<action>` | 200 or 202 |
| Wrong method on a real path | Any | 405 with `Allow` |

## Errors

Every error is `application/problem+json` with a stable `code` from
[a closed list](../../packages/contracts/artifacts/problem-codes.md). Branch on `code`,
never on `detail`, which is written for people. A rejected input also has
`errors[]`, each with a JSON Pointer `path`, a `code` and a `message`.

## Sign-in, and what a denial means

| Response | Meaning |
|---|---|
| 401 `auth.unauthenticated` | No valid credential |
| 403 `auth.token_scope_required` | The token is fine and needs another scope, which `detail` names |
| 403 `auth.token_not_supported` | The route needs a browser session |
| 403 `auth.forbidden` | Your role can't do this |
| 404 | It doesn't exist, or you can't see it. These look the same on purpose |

## Concurrency

Two mechanisms, each for its own case:

- **`If-Match` for a whole document,** such as a workflow draft. A stale tag answers 412
  with the current `ETag`; a missing one answers 428. `If-None-Match` on a draft read
  answers 304 if it hasn't changed.
- **An `expected...Revision` in the body for one facet of a resource,** because renaming a
  workflow shouldn't conflict with pausing it. A stale one answers 409. The name says which
  facet: `expectedNameRevision`, `expectedPauseRevision`.

Commands that change something take an `Idempotency-Key`. Repeat it to retry safely; the
same key with a different request answers 409.

## Lists

A list answers `{ items, nextCursor }`. Pass `nextCursor` as `after`, keeping the same
filters, and stop when it's `null`. A cursor is opaque. `limit` is at most 100 unless a
route says less, and public routes default to 50. Comments page
backward with `before`, since you read the newest first.

## What the reference leaves out

These follow someone else's protocol and aren't in the API reference:

- `/v1/auth/*`, the sign-in routes from Better Auth, such as `/v1/auth/sign-in/email`.
  Errors still come as problem documents.
- `/v1/auth/federation/scim/{organization}/v2/*`, which follows SCIM 2.0.
- `/hooks/{key}`, documented in [webhooks](webhooks.md), a URL you paste into another
  system, so it has no version.
