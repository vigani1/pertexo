# Production Exercise Harness

The HTTP runner schedules a bounded open-loop request rate and writes one
versioned JSON evidence file. It never writes session, CSRF, webhook signing,
authorization, or request-body values to evidence. Output creation is exclusive
so reruns cannot overwrite a prior result.

Executing these profiles against a deployed environment is E01-05 and requires a
completed
[external qualification approval packet](../../docs/operations/external-platform-contract.md#e01-05--admitted-load-fairness-and-autoscaling).
The base URL, every path/session/secret, synthetic workspace and workflow,
aggregate cost and repetition caps, operator, cleanup owner and approvers must
be resolved first. The checked-in rates and durations bound one invocation; they
do not authorize a target, cloud spend, provider send or repeat count.

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
pnpm exercise:http infrastructure/exercises/profiles/large-fan-out.json evidence/large-fan-out.json
pnpm exercise:http infrastructure/exercises/profiles/long-wait.json evidence/long-wait.json
pnpm exercise:http infrastructure/exercises/profiles/noisy-tenant-load.json evidence/noisy-tenant-load.json &
NOISY_PID=$!
pnpm exercise:http infrastructure/exercises/profiles/noisy-tenant-control.json evidence/noisy-tenant-control.json
wait "$NOISY_PID"
```

Use a dedicated shell for the concurrent pair if the approved operator tooling
does not preserve the background PID safely. One invocation schedules at most
1,200 `api-steady`, 15,000 webhook, 600 fan-out, 600 long-wait, 15,000
noisy-load and 3,000 control requests (35,400 total). Open-loop scheduling can
record fewer attempts under its in-flight bound; the evidence reports the actual
count.

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

Before launch, verify the target origin and hashed paths belong to the approved
synthetic environment. During the run, stop all clients on a target mismatch,
customer/provider effect, safety alarm, database connection-budget breach,
unbounded backlog or incident-command request. After stopping, do not delete
durable rows directly: allow accepted work to settle, use supported lifecycle
commands for synthetic workspaces, confirm queues/outboxes and provider effects
are settled, and have the packet's cleanup owner sign the retained JSON and
correlated telemetry record.
