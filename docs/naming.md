The rules are in `AGENTS.md`; this file explains them.

# File and directory naming

[`AGENTS.md`](../AGENTS.md) holds the rules under "Where code lives" and
"Naming and layout". This page says why they exist and shows them applied.

## Why one way of naming

A reader finds code by its path before they read it. When every package names
the same kind of file the same way, a path says what the file does and who may
change it: `connections.repository.ts` touches the database, `start-run.ts` is
one operation, `artifact-store.errors.ts` is where that store's failures are
named and translated. A file "just there with a different name" makes the
reader open it to learn what another package already says in its name.

## Names, with examples

| Instead of | Write | Because |
|---|---|---|
| `utils.ts`, `helpers.ts` | `command-retry.ts`, `response-charset.ts` | The name says the one concept the file owns. |
| `run.ts` holding three operations | `start-run.ts`, `advance-run.ts` | One operation per file, named verb and object. |
| `variables/replace-workspace-variables.ts` | `variables/replace.ts` | A private operation can take its object from the folder. |
| `runs/advance/run.ts` | `runs/advance/advance-run.ts` | Repeating the subject keeps an editor tab clear. |
| `runs/advance/runs-advance-advance-run.ts` | `runs/advance/advance-run.ts` | Never repeat the whole path. |
| `wf-cfg.ts` | `workflow-configuration.ts` | Words are never truncated. |
| `jobs.types.ts` holding a `const` | `jobs.ts` | `.types.ts` promises nothing survives compilation. |

A role suffix is worth adding when it tells the reader how the module takes
part. It is not a layer: renaming `storage.ts` to `storage.repository.ts`
moves no authority and changes no transaction. Keep a concept's types and
small values together under the concept's name rather than splitting a
coherent module just to earn a `.types.ts` or `.schemas.ts`.

## Where code lives, with examples

- **A limit:** the queue's transport attempts are `TRANSPORT_ATTEMPTS` in
  `queue/src/jobs/defaults.ts`, beside the job defaults they shape; nothing
  else writes `8`, and a change happens in one place.
- **Configuration:** `observability/src/config.ts` reads the environment once
  and returns a typed object; the telemetry runtime takes that object, never
  `process.env`.
- **A decision:** `rate-limit/src/rate-limit-policy.ts` decides which budgets
  a request counts against with no I/O; the limiters in `limiters/` apply it
  against Redis or memory.
- **Live connections:** `rate-limit/src/redis-rate-limit.runtime.ts` owns the
  Redis client's construction, deadlines and shutdown.

## Directories, with examples

`secrets/src/outbound-http/transport/` is a sub-area: the transport has its own
responsibility (address policy, the socket) inside outbound HTTP. A folder of
every repository in a package would be a role collection with no
responsibility, so it doesn't exist.

A single-file folder earns its place when it is an area that will be read on
its own (`templates/src/manifests/` holds one file per template) or a role slot
its peers share. An empty folder for code that might come later does not.

The ten-file prompt is a question, not a quota: fifteen executors for fifteen
nodes in one catalog are easier to scan than three folders invented to keep
each under ten.

## Tests, with examples

`queue/test/jobs/defaults.test.ts` mirrors `queue/src/jobs/defaults.ts`.
A behavioural name finishes its thought:
`retains-pending-charge-until-deletion.cases.ts`, not `retains-pending.ts`.
A `.cases.ts` file is imported by one discovered suite, so its cases run once.
