# Production Exercise Harness

The HTTP runner schedules a bounded open-loop request rate and writes one
versioned JSON evidence file. It never writes session, CSRF, webhook signing,
authorization, or request-body values to evidence. Output creation is exclusive
so reruns cannot overwrite a prior result.

All profiles require:

- `PERTEXO_EXERCISE_BASE_URL`: target origin.
- The profile's `pathEnvironment`: a concrete path to an existing provisioned
  workflow-run or webhook endpoint. Evidence stores only its SHA-256 digest.
- The profile's `bodyFileEnvironment`: a local JSON request body. The file is
  not copied into evidence.

Session-cookie profiles also require:

- `PERTEXO_EXERCISE_SESSION_COOKIE`: the raw value of a deployment-issued
  `pertexo_session` cookie.
- `PERTEXO_EXERCISE_CSRF_TOKEN`: the matching `pertexo_csrf` cookie and
  `x-csrf-token` header value.

The webhook profile instead requires `PERTEXO_EXERCISE_WEBHOOK_SIGNING_SECRET`,
the canonical base64url 32-byte secret returned when the exercise endpoint was
provisioned or rotated. Each request gets a current `x-pertexo-timestamp` and an
`x-pertexo-signature: v1=<hex-hmac>` over `timestamp + "." + rawBody`.

Run and validate profiles with:

```sh
pnpm exercise:check
pnpm exercise:http infrastructure/exercises/profiles/api-steady.json evidence/api-steady.json
pnpm exercise:http infrastructure/exercises/profiles/webhook-burst.json evidence/webhook-burst.json
```

Every checked-in scenario expects `202 Accepted`. Any other response, including
`401`, `403`, or `429`, fails the response-policy check even when throughput,
latency, and server-error objectives pass. A future rate-limit exercise may
expect `429` only when it also names the stable `*.rate_limited` RFC 9457
problem code.

The scenario profiles use only existing endpoint shapes supplied through
environment variables:

- `webhook-burst.json` targets a provisioned webhook endpoint at 50 requests per
  second for five minutes.
- `large-fan-out.json` and `long-wait.json` start pre-provisioned published
  workflows. Their HTTP evidence proves acceptance only; run completion, fan-out
  bounds, wait persistence, and worker-slot release require correlated
  run/database/telemetry evidence.
- `noisy-tenant-load.json` and `noisy-tenant-control.json` run concurrently in
  separate processes with separate tenant sessions, paths, bodies, and output
  files. Passing files alone do not prove fair admission; compare admitted work,
  oldest-job age, latency, and completion for both tenants under saturation.

A passing local file does not prove ECS, RDS, regional recovery, pager routing,
or production SLO attainment. Preserve production evidence in the approved
operations evidence system, not in Git.
