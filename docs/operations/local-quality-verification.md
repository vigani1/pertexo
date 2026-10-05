# Local quality qualification

Run the complete local backend qualification from a built checkout with Node 24,
pnpm 11, Docker, and Docker Compose:

```bash
pnpm quality:local
```

The command derives its local service contract from `.github/workflows/ci.yml`.
It allocates six available loopback ports, creates a unique Compose project,
starts PostgreSQL, Redis, both artifact stores, and both control-ledger stores,
bootstraps and migrates them, and removes only that project's containers,
networks, and volumes after success, failure, `SIGINT`, or `SIGTERM`.

Coverage writers remain serialized because all existing Vitest configurations,
the database coverage merge, and the risk report consume fixed `coverage/`
paths. A second run in the same checkout fails immediately with a lock-owner
diagnostic. Worktrees remain independent. Do not delete
`coverage/.local-quality.lock` while its recorded process is running.

Each run writes logs, Vitest JSON reports, and start/end source fingerprints to
`coverage/local-quality/<run-id>/manifest.json`. Qualification succeeds only
when the checkout remains unchanged, every required local cohort passes, and
every expected report is complete.
After the worker integration cohort finishes, the runner regenerates the risk
coverage report with that cohort's exact result file, run ID, source revision,
and candidate fingerprint. Full qualification rejects a report whose named
integration-only reviews were not actually executed and passed by that run.
The standalone `pnpm coverage:risk-report` command remains useful before
integration and labels those reviews `referenced-only`; it does not claim they
ran.
The manifest includes unit/static quality, coverage, a repeated isolated local
performance baseline, real-service integration, SSE resilience, worker
transport resilience, API and database compatibility, owned curated-template
qualification, deployment, image, and
exercise checks. The performance evidence is written beside the manifest, uses
the same owned services, and is validated against the schema-v5 evidence
contract before its exclusive output file is accepted. The full runner validates
it again before qualification succeeds. The manifest also names three AWS-only
control-ledger policy tests as skipped because local MinIO cannot qualify AWS S3
Object Lock or production bucket-policy enforcement.

For investigation, select cohorts explicitly:

```bash
pnpm quality:local -- --partial quality
pnpm quality:local -- --partial integration-api,sse-resilience
pnpm quality:local -- --partial curated-template-qualification
```

A partial run starts required service prerequisites automatically, records all
unselected cohorts as skipped, and labels its manifest `partial`. It is useful
diagnostic evidence but is never a complete qualification.

The curated-template cohort requires a clean, committed checkout. It attests
the exact PostgreSQL/Redis container IDs and loopback ports created by this run
through the canonical editor-browser ownership manifest, then sequentially runs
the origin guard (minimum 2,340 tests), metadata boundary (16), complete real
browser/API/worker scenario (1), and independently built compiled cutover and
compatible-off rollback (10). Every gate requires zero failures, skips, and todo
cases. Its fresh report directory contains report hashes and unchanged clean
start/end source fingerprints; the outer partial manifest remains diagnostic,
even when this complete nested qualification passes.

Ordinary API/database CI excludes only the owned origin guard and metadata
boundary in addition to its existing opt-in exclusions. The required
`curated-templates` CI job owns all four gates, full-history source checkout,
Chromium installation, disposable services, cleanup, and uploaded source-bound
reports. It writes reports outside the checkout so evidence cannot dirty the
qualified source. Never enable the owned flags against discovered/shared
services or substitute a passing file wrapper for actual cutover test counts.

Before offline compiled cutover builds, prepare all three exact source refs
(pre-origin, pre-organization, and current compatible source) with
`node infrastructure/testing/prepare-curated-cutover-cache.mjs`. Set absolute
`PNPM_CONFIG_STORE_DIR` to `pnpm store path --silent` and an owned absolute
`PNPM_CONFIG_CACHE_DIR`; retain both for qualification. Preparation archives each
ref separately and runs pinned pnpm's frozen, script-free fetch, recording source
and unchanged lock hashes. Package content alone is insufficient: fresh installs
also need metadata for pnpm's supply-chain verification. Every artifact build
still starts from a fresh archive and installs offline without network fallback.

Ordinary PR CI keeps its stable `quality` check name and runs the service-free
`architecture:check`, `built-exports:check`, and `quality:local:check` gates.
The build step precedes built-export validation. A semantic policy validator
checks those CI owners, their local `check` ownership, and the nested
`performance:local:check` contract. Full `quality:local` remains excluded from
that static job; mutation execution remains owned by the disposable
`integration` job. Local success confirms repository configuration, not hosted
execution or branch-protection settings; those require an exact-revision PR run
and externally retained required-check evidence.
