# Local quality qualification

Run the complete local backend qualification from a built checkout with Node 24,
pnpm 11, Docker, and Docker Compose:

```bash
pnpm quality:local
```

The command derives its local service contract from `.github/workflows/ci.yml`.
It allocates five available loopback ports, creates a unique Compose project,
starts PostgreSQL, Redis, the artifact store, and both control-ledger stores,
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
The manifest includes unit/static quality, coverage, a repeated isolated local
performance baseline, real-service integration, SSE resilience, worker
transport resilience, API and database compatibility, deployment, image, and
exercise checks. The performance evidence is written beside the manifest and
uses the same owned services. The manifest also names three AWS-only
control-ledger policy tests as skipped because local MinIO cannot qualify AWS S3
Object Lock or production bucket-policy enforcement.

For investigation, select cohorts explicitly:

```bash
pnpm quality:local -- --partial quality
pnpm quality:local -- --partial integration-api,sse-resilience
```

A partial run starts required service prerequisites automatically, records all
unselected cohorts as skipped, and labels its manifest `partial`. It is useful
diagnostic evidence but is never a complete qualification.
