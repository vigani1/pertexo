# Infrastructure: observability assets and HTTP exercises

Date: 2026-09-12. Twenty files fully read (JSON profiles/dashboard judged as
data against their explicit consumers). Eight exercise tests, profile validation
and YAML/dashboard structural validation passed. No HTTP load, telemetry
collector, Prometheus container or production endpoint was started/contacted.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `infrastructure/observability/compose.yaml` | KEEP; conditional startup TEST | Digest pins, loopback-only published ports and local viewer credentials match disposable local use. Verify readonly Prometheus has its required writable data mount from the pinned image and Grafana nested tmpfs/bind provisioning starts correctly; do not infer container startup from YAML validity. |
| `infrastructure/observability/otel-collector.yaml` | WQ-222 TEST/CONDITIONAL | Resource identity stripping protects privacy, but does not aggregate independent metric writers. Memory limiter before batch and explicit receiver/exporter pipelines remain justified. Trace debug exporter is local diagnostics, not durable trace storage. |
| `infrastructure/observability/prometheus.yaml` | KEEP; WQ-222 TEST | One collector target and 15s intervals are clear. Fresh scrapes of cached exporter values are not automatically fresh upstream observations. |
| `infrastructure/observability/grafana-dashboards.yaml` | KEEP | Readonly provisioned dashboard location and UI updates disabled align with repo-owned assets. |
| `infrastructure/observability/grafana-datasource.yaml` | KEEP | Fixed prometheus UID matches every panel and uses internal service endpoint; no customer credentials. |
| `infrastructure/observability/validate-config.mjs` | KEEP; shared WQ-021 | Strict YAML/unique keys/no aliases plus minimal shape checks are honest structural validation. Actual collector config/promtool commands are separate package scripts; add semantic fixture coverage there rather than claiming this parser validates PromQL or datapoint flow. |
| `infrastructure/observability/pertexo-alerts.yaml` | WQ-222 TEST; otherwise KEEP | Rules distinguish user impact, backlog, dependency health and destructive control. Fixed metric vocabularies/runbook anchors are consistent with asset test intent. Worker starts and replica-staleness predicates need real timeseries fixtures; descriptions such as sufficient traffic are not enforced by an explicit sample floor. |
| `infrastructure/observability/grafana-dashboard.json` | DATA; WQ-222 TEST | Twenty-one explicit panels preserve bounded labels and distinguish backlog from throughput. Some panels combine seconds/count/bytes with no per-target unit override; add field overrides or separate units during normal dashboard refinement, not backend refactor. Per-process/max/sum claims require retained writer distinction before aggregation. |
| `infrastructure/exercises/run-http-exercise.mjs` | WQ-220/WQ-221 | Secret-safe evidence and explicit authentication/response policy are good boundaries. Result creation occurs after side effects; execution statistics and bounds need actual runner tests. |
| `infrastructure/exercises/run-http-exercise.test.mjs` | WQ-220/WQ-221 TEST | Eight pure auth/target/policy tests are meaningful but never run scheduler, IO/evidence lifecycle, body failure or concurrency bound. Add injected execution tests without live target. |
| `infrastructure/exercises/validate-exercises.mjs` | KEEP | Exact finite scenario set and webhook-specific auth mapping provide clear config inventory. Explicit six filenames are appropriate; newly added profile files should be discovered/compared if supported. |
| `infrastructure/exercises/profiles/api-steady.json` | DATA/KEEP | 60s × 20/s with 40 max in-flight and exact 202 requirement is a bounded acceptance scenario, not completion proof. |
| `infrastructure/exercises/profiles/large-fan-out.json` | DATA/KEEP | 60s × 10/s with supplied prepublished graph separates fixture semantics from scheduler. Correlate fan-out execution evidence separately. |
| `infrastructure/exercises/profiles/long-wait.json` | DATA/KEEP | Same start rate is intentional comparative input; slot release and durable wait require external run evidence, clearly documented. |
| `infrastructure/exercises/profiles/noisy-tenant-control.json` | DATA/KEEP | 300s × 10/s control workload needs distinct tenant session and coordinated noisy run; isolated passing report is not fairness. |
| `infrastructure/exercises/profiles/noisy-tenant-load.json` | DATA/KEEP | 300s × 50/s bounded noisy input preserves same response policy to expose rejection; scenario-local JSON repetition is clearer than hidden profile inheritance. |
| `infrastructure/exercises/profiles/webhook-burst.json` | DATA/KEEP | 300s × 50/s with HMAC and exact acceptance status aligns explicit webhook authorization and raw-body signing. |
| `infrastructure/exercises/README.md` | KEEP; WQ-220 clarification | Explicit target/cost/cleanup approval packet, scenario limitations and 35,400 total requests avoid treating local scripts as deployment authorization. Document output-path preflight and interrupted evidence status when implementation changes. |
| `infrastructure/minio/primary-ledger-policy.json` | DATA/KEEP | Bucket inspection and prefix-only Get/Put with explicit Delete/version-delete/replication deny separate ledger writer from admin; does not by itself establish bucket retention/object-lock configuration. |
| `infrastructure/minio/recovery-ledger-policy.json` | DATA/KEEP | Symmetric permissions on recovery bucket/prefix are intentional independently deployed policy, not harmful code duplication. |

## WQ-220 — reserve an evidence destination before launching side effects

P2 FIX. `run-http-exercise.mjs:main` executes the whole HTTP run, then mkdir and
writeFile(flag='wx'). Existing output, missing permissions or invalid destination
therefore fail only after potentially thousands of accepted operations. Exclusive
creation protects prior bytes but does not prevent accidental repeat traffic or
loss of all new evidence. Validate inputs and reserve exact output exclusively
before the first fetch; capture a versioned started/interrupted/completed record
without secret values. Use a clearly specified atomic-finalization strategy and
retain interrupted evidence rather than deleting proof of an executed exercise.
Tests: existing path and denied destination cause zero requests; input failure
creates no misleading completed result; interrupted run records counts and
requires operator cleanup; successful final evidence remains mode 0600 and
cannot overwrite unrelated output. No live load to prove this condition.

## WQ-221 — separate exercise scheduling, outcomes and evidence arithmetic

P2 FIX/REFACTOR/TEST. `run` is a cohesive orchestration owner, but its counters
are mutated before body processing and again in catch: a received 5xx whose
problem-body read fails increments both 5xx and transport_error, then
serverFailures adds both for one completion. Define one primary outcome per
attempt (with optional separate body-read diagnostic) so failure ratio cannot
exceed one and status totals reconcile with completed attempts. Unexpected
responses must not be counted twice on policy mismatch plus cancel failure.

`parseProfile` uses finiteNumber for maxInFlight and accepts 1.5; integer
inFlight >= 1.5 then permits two requests, violating the supplied cap. Require
safe integer concurrency. Decide and document whether fractional rate/duration
remain supported; preserve their current scheduled=floor(product) contract if
retained. Validate header field-value bytes before load rather than producing
thousands of predictable transport failures.

Extract injectable clock/scheduler/fetch/evidence seams, keeping auth and target
validation independent. Test exact request count, max live requests, skipped
slots, event-loop delay/catch-up policy, elapsed-rate denominator, empty results,
30s response deadline, streamed problem-byte bound, HTTP/body/network failures,
redaction and counter invariants. A scheduler delayed past intended duration
must have an explicit catch-up/skip policy, not accidental burst semantics.
Retain same-origin/manual-redirect behavior, canonical webhook secret handling,
fresh idempotency IDs and no body/token/secret evidence. Acceptance remains
HTTP admission, never workflow completion or fairness without correlated data.

## WQ-222 — qualify metric aggregation and alert meaning across writers

P2 TEST/CONDITIONAL, not reproduced deployment failure. Collector
`resource/drop_process_identity` removes service.instance.id/host/process
identity; Node resources otherwise share service/environment/version across
replicas. Multiple independent cumulative counters and gauges are not safely
combined merely by deleting resource attributes or by a downstream sum/max.
OpenTelemetry explicitly requires writer differentiation or nonoverlapping
streams in its [metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/).

First run a disposable exact-pinned pipeline with two same-service producers,
independent counter increments/gauges and one restart. Assert collected counts,
histograms, per-service sum/max and scrape validity; inspect writer collisions,
resets and dropped/replaced series. Preserve privacy prohibitions: do not simply
export hostnames, PIDs, tenant IDs or arbitrary instance labels. If needed,
choose bounded privacy-safe writer identity or collector-side aggregation with
correct cumulative temporality/reset handling, and record a narrowly scoped
ADR only if this changes the accepted observability contract. Keep the current
pipeline if tested aggregation already proves these invariants.

`recordWorkerProcessStart` adds one once in each fresh process; increase of a
per-process counter that remains at one is not a reliable restart counter, and
discarded identity cannot repair it. Use an external supervisor event/count or
a tested restart-observation model; test five/six restarts and rapid crashes
before first 60s metric export. `PertexoRegionalWriteAdmissionPaused` also needs
stopped-producer/cached-exporter tests: 30s absent_over_time of collector scrapes
is not equivalent to freshness of the originating replica observation. Test
SDK export cadence, cache expiry and allowed detection latency explicitly.

Add promtool rule test fixtures for no traffic, threshold/below-threshold,
counter reset, partial-series absence and explicit for durations; existing
promtool check rules establishes syntax only. Link to WQ-021 operations asset
tests and WQ-218 external metric/alarm qualification, keeping local semantic
tests distinct from actual pager delivery and deployed SLO evidence.
