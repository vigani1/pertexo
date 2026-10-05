# Registered inline JSON Call qualification

The c118 local milestone is historical evidence, not a supported installation
path. Its local-only cohort, environment flag, installer, fixed loopback ports
and readiness substitutions have been removed. Their previous versions remain
recoverable from Git history. Do not apply the deferred candidate SQL to a
normally migrated database.

## Current Phase 1 qualification

Use a fresh disposable database on PostgreSQL and an owned empty Redis namespace.
The dedicated `inline-workflow-call-http` CI job builds ordinary source, starts
its own dynamically named Compose project, and runs:

```sh
node --test --test-reporter=./infrastructure/testing/inline-workflow-call-gate-reporter.mjs infrastructure/testing/inline-workflow-call-http.integration.test.mjs
```

The job supplies standard admin, migration, API, worker, dispatcher and operator
database URLs, `REDIS_URL`, `INLINE_WORKFLOW_CALL_HTTP_INTEGRATION=true`, and an
absolute `INLINE_WORKFLOW_CALL_GATE_REPORT` path. Missing configuration fails;
there is no skipped-service alternative. Startup and Compose teardown have
120-second bounds, the test has a 180-second ceiling, and the job has a
15-minute deadline. The actual Node test summary must contain one passing test
and no skipped, pending, cancelled or todo tests. The report is uploaded even
when the qualification fails.

The fixture uses the normal migration runner through 0139. It creates retained
manual drafts through real authenticated HTTP at epoch 1, then advances through
each ordinary compatibility successor with real API/worker catalog probes and
the prepare, preactivation, approval and activation owners. No current-release
row is rewritten and no replication bypass is used. The serving cohort is
`workflow_call_activation` (epoch 40), after Validate-active and Call-staged.

## Admission and drain evidence

The non-Call V3 child publishes while the database flag is OFF. Fresh Call
publication returns `503 workflow.calls_unavailable`. The operator enables
Calls through `app.set_workflow_calls_enabled(true)`, then the fixture publishes
the pinned parent and accepts its root through HTTP. The operator switches OFF
before any worker is started.

Fresh Call publication and root acceptance then return 503; exact publication
and accepted-root replays still succeed. Ordinary coordinator, node-attempt and
outbox-dispatcher runtimes start while OFF and drain the accepted parent and
child to successful `{ "answer": 42 }` results. HTTP family readers and persisted
Call facts verify the exact child version and parent linkage. Unused external
connection/artifact capabilities fail closed and are asserted never called;
this test does not qualify those provider or artifact paths.

## Scope and historical evidence

Calls default OFF on every installation. This disposable test does not activate
production or authorize deployment. Registered inline catalog readiness is
exact and independent of flag value. The complete deferred-native readiness
guard remains separate and unqualified.

The c118 milestone showed canonical publication, root acceptance, Call
admission, waiting/wakeup, physical completion, and parent/child facts. It used
a local-only schema and release setup, so it was never native production
qualification. Controls, artifact behavior and ownership, retention mutation,
ADR066 authority, and notification routing remain outside Phase 1. Legacy
Slack/email routing remains the baseline. The six deferred retention owners are
unchanged by the registered inline migrations.
