# @pertexo/api

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The HTTP API: NestJS on Fastify. It signs callers in, checks their route's
access, parses the declared input, calls `core` and answers in the declared
shape. Rules live in `core`, `workflow-engine` and `policy`; the API adapts
requests to them and turns their errors into problems. It reads the
environment only in `platform/config/`.

## Layout

- `src/main.ts`: the process entry. `src/app.ts`: builds and starts the HTTP
  application (the production-image check in CI and publish loads its built
  file).
  `src/app.module.ts`: the Nest composition root.
- `platform/`: what every area shares: `config/` (settings, read once),
  `http/` (the route helper `Route`/`In`, problem details, request context,
  cursors, CSV), `api.runtime.ts` (acquiring and closing every live
  runtime), and one `<subject>/` per runtime module (database, identity,
  workflow, webhooks, schedules, notifications, artifacts, connections).
- `problems/`: the problem registry and the per-area mappings from domain
  errors to problems.
- `authorization/`, `authentication/`, `identity/`, `workspaces/`: who the
  caller is and what they may do. `workspaces/request/caller.ts` holds
  `@Caller()`.
- One directory per product area (`workflow-authoring/`, `workflow-runs/`,
  `connections/`, `webhooks/`, `schedules/`, `forms/`, `artifacts/`,
  `data-tables/`, `workspace-variables/`, `notifications/`,
  `pending-tasks/`, `governance/`, `api-tokens/`, `node-testing/`,
  `catalog/`), each with its `.module.ts`, `.controller.ts` files and its
  services or operations.

## Where new code goes

- A new route: declared in `@pertexo/contracts` (`routes/`), registered on a
  handler with `@Route(route)`, its input taken with `@In()`.
- A handler in a workspace route takes `@Caller() caller: WorkspaceCaller`
  and hands core `storeCaller(caller)` (a core store),
  `serviceCaller(caller)` (an API service) and `requestIdentifiers(caller)`
  (commands). It never projects the request itself.
- A service builds a core command's context from its input with the same
  file's `storeContext(input)` (workspace, actor and command token),
  `commandContext(input)` (that and the request's identifiers) or
  `requestIdentifiers(input.actor)`, never field by field.
- A controller reaches core through one door: the area's core store,
  injected by token, or the area's service when routes need coordination
  the store doesn't do (config, secrets, several ports). A service exposes
  the store it wraps as `store` for the routes that need nothing more,
  rather than forwarding each call. HTTP-only work over a store (an opaque
  cursor, a CSV parse) is a verb-named operation that takes the store
  (`workspace-variables/read-usage-page.ts`, `data-tables/import-csv-rows.ts`).
- API service classes are named `…Service`, in `.service.ts` files or a
  verb-named operation file.
- A domain error that callers see: its class in the area's `.errors.ts`, and
  its problem mapping in `problems/`.

## Defaults and config

- Settings: `platform/config/api-config.ts` (and `identity-config.ts`,
  `instance-limits.ts`), parsed once at startup and passed inward.
  `api-config.ts` and `api-configuration.errors.ts` are host-mounted
  internals (`MOUNTED_INTERNALS`); keep their built paths.
- Limits are named where they bound something, and the limits check covers
  the app. Shared ones have one owner: HTTP statuses are Nest's
  `HttpStatus` wherever the API sends one (`validate-http-statuses.mjs`);
  a comparison with a received number writes the number, since lint refuses
  comparing an enum with a number; a token's random bytes are
  `SECRET_TOKEN_BYTES` and its length `SECRET_TOKEN_CHARACTERS`
  (`identity/secret-token.ts`); a provider callback's parameters are
  `CALLBACK_LIMITS` (`authentication/journeys/callback-limits.ts`);
  passwords, display names and the fresh sign-in window come from
  `workflow-model`; a newly entered email address (sign-up, email change,
  invitations, mail senders) is bounded by
  `EMAIL_ADDRESS_LIMITS.newAddressCharacters` (254), and Better Auth's sign-up
  and email change by `email-length-plugin.ts`, while a lookup of an existing
  account (sign-in, SSO, SCIM, password reset) accepts the stored
  `storedAddressCharacters` (320); raw headers are read through
  `platform/http/raw-headers.ts`.
- How routes check their answers: `platform/http/route-answer-check.ts`
  (production projects to the declared shape; other environments check
  strictly), set by `app.module.ts` from the config.

## Rules

- The route helper checks every answer against the route's declared
  success body, so a service returns what it built and never parses it
  against that schema again. A parse stays only when it is a rule of its
  own (an over-limit validation report, a batch item whose malformed result
  makes only that item unknown).
- Errors are specific classes in each subject's `.errors.ts`; the problem
  filter turns them into safe messages once.

## Exceptions

- Generic throws that stay are assertions: the safe-detail length
  (`platform/http/application-error.ts`), a duplicate problem registration
  (`platform/http/problems/error-registry.ts`), a route without a rate-limit
  class (`platform/rate-limit/interceptor.ts`), an unknown connection-test
  outcome (`connections/testing/outcomes.ts`) and a webhook health
  projection of another trigger kind
  (`webhooks/management/webhook-management.service.ts`).
- `workflow-authoring/portability/workflow-portability.controller.ts`: export
  and import take five handler arguments, because Nest binds each by its
  decorator's position.

## What guards it

- `pnpm --filter @pertexo/api test`: routes through the real Nest pipeline
  (guards, input parsing, problem filter) with fake stores, plus services and
  operations.
- `pnpm --filter @pertexo/api test:integration` needs PostgreSQL and Redis:
  routes over real core stores.
- `pnpm check`: package structure, naming, environment, dist-reference and
  module-import checks.
