# Local pinned JSON Call

This is an isolated development milestone, not native production qualification.
The six exercised owners are canonical publication, root acceptance, Call
admission, waiting/wakeup, physical completion, and parent/child facts.
Production readiness and migration registration remain unchanged. The candidate
SQL retains its installation abort. Controls, artifacts, retention and ADR066
authority are not qualified by this exercise. Legacy Slack/email routing remains
the baseline.

## Fresh local setup

Use a disposable checkout and fresh volumes. The installer refuses a database
where `app.workflow_calls` already exists; it is not an upgrade or reset tool.
It accepts only the Compose project `pertexo-f08-local-json-call-20261005`, its
PostgreSQL container and the loopback database on port 51243.

Prepare an ignored `.env` using the local example's disposable credentials.
Do not copy production credentials. Required configuration groups:

- `COMPOSE_PROJECT_NAME`, `NODE_ENV`, `PERTEXO_LOCAL_JSON_CALL`, and
  `NODE_COMPATIBILITY_COHORT`: the exact owned project, development environment,
  explicit enabled opt-in, and `local_json_call` cohort.
- `POSTGRES_PORT`, `REDIS_PORT`, the primary/recovery artifact and control-ledger
  ports: 51243 through 51248. Configure the corresponding database URLs,
  `REDIS_URL`, artifact-store endpoints, and control-ledger endpoints for
  loopback. The database is named `pertexo`; connection URLs must have no query
  overrides. API, worker and dispatcher retain their separate runtime roles.
- `DATABASE_MIGRATION_URL`, `DATABASE_API_URL`, `DATABASE_WORKER_URL`, and
  `DATABASE_DISPATCHER_URL`; `DATABASE_CONNECTION_TIMEOUT_MILLIS` must be within
  the native coordinator's 2000 ms control-read bound.
- Artifact-store and control-ledger bucket, region, access-key and secret-key
  environment names from `.env.example`, including both recovery endpoints.
- `HOST`, `PORT`, `PUBLIC_WEB_ORIGIN`, `PERTEXO_API_PROXY_TARGET`,
  `BETTER_AUTH_SECRET`, and `AUTH_MAIL_MODE`: API loopback port 51253, web
  loopback port 5173, and local authentication mail.
- `OUTBOX_DISPATCH_JOB_NAMES`: the existing coordinator and node-attempt jobs
  (`advance-workflow-run`, `execute-node-attempt`).

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
docker compose -p pertexo-f08-local-json-call-20261005 up -d postgres redis artifact-store artifact-store-recovery control-ledger-primary control-ledger-recovery control-ledger-primary-bootstrap control-ledger-recovery-bootstrap
node --env-file=.env packages/database/dist/migrate.js
node --env-file=.env infrastructure/development/setup-local-json-call.mjs
pnpm dev
```

After API and worker startup, run in another terminal:

```sh
node --env-file=.env infrastructure/development/local-json-call.mjs
```

The installer removes the abort only from its in-memory local SQL copy, renders
the existing role placeholders, and leaves registered migration head 0136.
The fixed local release stages Call at epoch 3 and activates it at epoch 4;
ordinary release identities are unchanged. Local readiness substitutes only the
five native-schema capabilities that differ from the registered baseline, checks
the exercised owner schema, and retains the other baseline checks. Production,
staging, test, remote database/Redis and public API binds reject this opt-in.

## Fixture boundaries

The repro seeds only a disposable verified authentication account. Workflow
drafts, publication, run acceptance and execution go through the real HTTP and
queue owners. It temporarily selects exact retained epoch 1 to create both
manual drafts through HTTP, then restores verified local epoch 4 in `finally`.
This is fixture setup, not support for newly placing deprecated manual nodes in
epoch 4. It enables the existing checked-manual rollout row only after asserting
its writer fence. No workflow/version/run/Call rows are seeded.

The child uses Set to return `{ "answer": 42 }`. The parent pins its immutable
version, checksum and callable-contract identity. The repro asserts real parent
waiting, one admitted child, successful parent/child facts, exact pin and both
JSON outputs. It also verifies receipt owner locking while denying cross-workspace
and other-consumer reads and owner mutation. Negative receipt fixtures roll back.

## Observed failures and repairs

| Observed boundary | Focused repair |
| --- | --- |
| Development services received no environment-file variables | Direct launcher forwards the parsed environment. |
| Child compiler lacked Call policies | Fixed local application composition uses the existing V3 composer. |
| New executor could not start active | Existing staged-then-active registry transition. |
| Legacy readiness rejected native schema and concurrency bodies | Guarded local variant; ordinary exact checks unchanged. |
| Deprecated manual node could not be newly placed | Explicit retained-manual HTTP fixture setup. |
| Checked manual start returned 503 | Enable existing owned rollout after writer-fence check. |
| Root checkpoint exact keys omitted `initialIterationBudget` | Bind its initial equality and include the contract field. |
| Physical source could not read its receipt | Scoped native attempt owner SELECT policy. |
| Call completion could not lock its receipt | Scoped owner lock visibility with mutation `WITH CHECK (false)`. |
| Call admission option was absent | Wire the existing option and verified V3 child checkpoint in local composition. |
| Call waiting violated control-kind and wait-state checks | Add Call to the existing no-timer logical barrier shape. |
| Child result demanded an already accepted checkpoint output | Derive pending non-Call output from current completed physical success; retain provenance and CAS/logical fences. |

Verification setup errors were also corrected: optional Redis typing in the
API guard, two redundant optional chains reported by ESLint, and an invalid engine dependency in a database test. Neither was
reported as a passing build or test. Temporary incremental SQL repair modes were
removed after the successful runs; fresh setup uses the final candidate directly.
The initial ESLint process exhausted its default 4 GB heap; the final explicit
owned-file lint passed with `NODE_OPTIONS=--max-old-space-size=8192`.

## Verified result (2026-10-05)

The first successful parent run was
`01a10ca5-5902-72b8-8307-76df69ce07fc`; child run
`01a10ca5-5e86-7337-9e48-dfbb9c9b5a3d` pinned child version
`01a10ca5-583b-776e-bb4d-21aeac072c64`.

The repeated run including policy negatives was parent
`01a10ca8-2e90-73f1-b51f-f90bb502683a`, child
`01a10ca8-337c-7403-af64-77ced74a3cf4`, pinned child version
`01a10ca8-2de9-776d-a49a-85a2244f5a79`. Both outputs were inline
`{ "answer": 42 }`; parent observations were queued, running, waiting, succeeded.
The exact child checksum was
`wf:v3:sha256:2580f0adc81fb6f954bec97d5b1d83a23cc0df60d475d750d898e4aae5c043a7`.

After restarting the actual `pnpm dev` stack, the final repro also passed:
parent `01a10cae-cebc-71b8-a08a-fc236398f646`, child
`01a10cae-d3ec-744a-9950-e5ec6c0877e9`, pinned child version
`01a10cae-cdd7-73fb-8449-a8a66d913620`, parent version
`01a10cae-ce50-732b-8216-51920aa5ee1b`, workspace
`01a10cae-cc8a-7343-b14c-fdb704151754`. Both outputs were 42, admission was
sealed as admitted, and queued/running/waiting/succeeded were observed.

Verification: 247 tests across API/worker config, catalog registry/resolution,
database local source/checkpoint contracts and coordinator composition passed.
`pnpm build`, final TypeScript build and explicit owned-file ESLint passed, with the existing web chunk-size warning. Installed bodies for seven exercised owners matched the final candidate; installed receipt policies and Call constraints matched its saved expressions. The complete final fresh installer was not rerun against a new empty database. No complete native
qualification, production deployment or push is implied.
