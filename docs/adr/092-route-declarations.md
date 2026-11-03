# ADR 092: Each API route is declared once

- **Status:** accepted
- **Date:** 2026-11-02

## Context

One route's facts lived in five places: Nest decorators, a guard class per module,
`.parse` calls in the handler or below it, a separate OpenAPI entry, and a response
`.parse` in a service. Nothing made them agree. A route could lose its CSRF guard with
every test still green, a query parameter could be required in code and optional in the
document, and 95 of 133 write routes answered a bad body without saying which field.

## Decision

**`@pertexo/contracts/server` holds a `defineRoute` per route:** method, path, sign-in
kind, coarse capability with its status list and disclosure, rate class, idempotency,
parameter, query and body schemas, success status and schema, and the documented
problems. OpenAPI paths and component schemas are generated from it.

**`@Route(declaration)` registers the handler from it,** including CSRF, which follows
from a session route that isn't a GET and can't be left out. `@In()` gives the handler
its parsed input. A parse failure there is the caller's and always returns `errors[]`
with JSON Pointer paths. The response is checked against the declared schema; a mismatch
is our fault and answers 500, where a service's `.parse` used to read as a 400.

**The capability isn't the authority.** Access depends on the resource, and core
re-checks it under lock. The declaration holds the coarse check only.

**Not every route fits.** Webhook ingress, callbacks, Better Auth and SCIM take raw bytes
or follow someone else's protocol, so they stay outside Nest and keep hand-written
documents.

## Consequences

The completed migration declares 238 of 250 configured Nest routes; 12 keep
intentional protocol-specific admission. Raw Fastify protocols remain hand-written.
Across the declaration migration and its required helper/type/cleanup commits through
`7b495239e`, production API source shrank by 2,983 lines and contracts source grew by
897: **2,086 lines saved overall**, including the shared machinery. Generated
artifacts, tests, token feature growth and unrelated behavior fixes are excluded.
The three shared declaration, OpenAPI builder and Nest adapter files total 709 lines
at migration completion.

The early 5,000–6,000-line forecast did not hold. Some modules grew: their gain is
one executable contract for input, admission, success shapes and documentation.
The special cases use explicit seams rather than a second routing engine. Keep
raw sanitized portability input and native-form CSV parsing at their own boundary;
probe and external protocol handlers do not need a declaration merely for coverage.
