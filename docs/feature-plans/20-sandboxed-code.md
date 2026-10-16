# F20 — Code step

Status: decided by the owner on 2026-10-16; approved for implementation.
Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decision record: write the ADR (next free number) in slice 1 from this plan.

## Outcome

Workflow builders write a short JavaScript step for transforms the built-in
steps can't express. The code runs at full Node speed with common libraries,
and it can't reach the database, Redis, secrets, the network or other runs.

## Decisions

- **Engine: real Node.** User code runs as normal Node.js in single-use
  processes, for full speed, modern JavaScript, Node built-ins and npm packages.
  This matches what n8n, Zapier and Make users expect.
- **Isolation comes from a dedicated runner container**, never from a
  language sandbox inside an existing process. Code never runs in the API or
  worker process. Node's `vm` module is not a security boundary.
- **One runner design for every install.** Self-hosters get the same hardened
  runner the default Compose setup ships; there is no weaker mode.
- **Hosted direction.** A future paid cloud gives each customer their own
  instance, like n8n Cloud, so customers never share a runner.
- **Rejected alternatives**, recorded in the ADR:
  - `vm` and `vm2`: not security boundaries; vm2 has many escapes.
  - isolated-vm: a native addon in maintenance mode, and it can't load npm or
    Node built-ins.
  - QuickJS compiled to WebAssembly: the strongest in-process sandbox, but
    10–50× slower, with no Node built-ins or npm. Revisit only if a shared
    multi-tenant system is ever built.
  - A container per run: too heavy for a single server.

## Runner

- A new app, `apps/code-runner`, built into the existing image and started by
  its own command. It must not depend on the database, queue, integrations or
  any credential code; extend the module-import check to enforce this.
- A Compose service `code-runner`:
  - `network_mode: none`;
  - read-only root filesystem, tmpfs `/tmp` (noexec);
  - `no-new-privileges`, all capabilities dropped except those needed to start
    run processes as other users;
  - memory and CPU limits derived from the code-step settings;
  - no shared secret environment: it must not use the shared environment
    anchor; it gets only its own limit settings.
- The worker talks to it over a Unix socket on a volume shared only by the
  worker and the runner. The protocol uses bounded JSON messages: task in, one
  result out. The socket is reachable by the worker, not by run processes.
- The runner's managing process keeps a small pool of pre-started, unused run
  processes. Each run process executes exactly one task and is then discarded,
  so no state, module cache or memory crosses runs or workspaces.
- Run processes:
  - run as a different unprivileged user from the managing process, one per
    concurrency slot, so a run can't read, signal or trace the manager or
    another run;
  - start with Node's permission model: no file writes, no child processes,
    workers, addons, WASI or inspector; reads only the runner code and allowed
    packages;
  - get the task on stdin and return the result on a dedicated file
    descriptor, so the user's console output can't corrupt the protocol.
- Local development starts the same runner as a separate process with the same
  socket protocol, without user switching; document that this is weaker. CI
  integration tests use the same process mode, and Compose tests check the
  hardened container settings.

## Step contract

- `core.code@1` with config `{ code, timeoutSeconds }`. The code is at most
  64 KB and stays part of the immutable workflow version.
- The code is the body of an async function. It receives `input` (the step's
  mapped input as JSON) and `$vars` (the run's workspace variables), and it
  returns a JSON value that becomes the step output. Plain JSON only: no
  functions, cycles, class instances, `undefined` or non-finite numbers.
- Clean global scope: standard JavaScript and Web globals, `console` (captured)
  and `require` for allowed modules only. No `process`, `fetch`, `WebSocket`
  or other network globals.
- Allowed Node built-ins: `assert`, `buffer`, `crypto`, `events`, `path`,
  `querystring`, `string_decoder`, `url`, `util`, `zlib`. Everything else is
  refused with a clear message, including `fs`, `net`, `http(s)`, `http2`,
  `tls`, `dns`, `dgram`, `child_process`, `cluster`, `worker_threads`, `vm`,
  `inspector`, `v8`, `module` and `os`.
- Preinstalled npm packages: `lodash` and `dayjs`, pinned with advisories
  checked. The admin can allow more packages present in the image through an
  allowlist setting; document how to build a custom image with extra packages.
- Retry class `safe`: a run process has no network or credentials, so it can't
  cause external effects.
- The executor in `nodes-core` uses a worker-provided code-runner capability.
  Node packages never spawn processes themselves. Published runs and editor
  previews use the same runner.

## Limits and settings

Instance settings, with safe defaults the server admin can raise:

| Setting | Default | Range |
| --- | --- | --- |
| Code steps enabled | on | on/off |
| Memory per run | 128 MB | 32 MB–1 GB |
| Maximum run time | 30 s | up to 5 minutes |
| Concurrent runs | 2 | 1–16 |
| Extra allowed packages | none | names present in the image |

- Each step chooses its own time limit within the maximum, default 5 seconds.
  Step settings show the effective limits.
- Enforcement: the heap cap comes from the memory setting, and the container
  limit bounds the total; the manager kills the run process at the deadline.
  Input, output and captured console output stay within the existing run value
  limits; console output also has a line cap.
- When Code steps are off, publishing a workflow with one is refused, and a run
  that reaches one fails with `code.disabled`.
- When no slot is free, the attempt waits within its lease and otherwise
  retries through the normal safe retry path.

## Errors

Closed safe codes for routing and summaries: `code.syntax_error`,
`code.runtime_error`, `code.timeout`, `code.memory_limit`,
`code.output_invalid`, `code.module_refused`, `code.disabled` and
`code.runner_unavailable` (retryable). Failure routes (F09) handle them like
other step failures. The user's own error message (bounded) and line/column
are visible to run readers, but never appear in emails, notices or
error-workflow summaries.

## Editor

- A code field with syntax highlighting (a maintained editor component such as
  CodeMirror 6) and live syntax errors from one shared JavaScript parser (such
  as acorn). Publish validation reuses that parser; no code runs in the API.
- A test button that runs through previews, including pinned data (F02), with
  a logs panel and the effective limits.
- A user guide at `docs/guides/code.md`: contract, allowed modules, limits,
  examples, and what Code steps can't do (network; use HTTP Request instead).

## Slices and status

| Slice | Status |
| --- | --- |
| 1. ADR, runner app and Compose service, protocol, `core.code@1` runtime through the worker, settings, hostile-code and isolation suite | Planned |
| 2. Editor: code field, syntax errors, test with previews and pinned data, logs, limits display, guide | Planned |

Slice 1 is usable through the API and import before the full editor lands; a
plain code field is acceptable until slice 2.

## Acceptance

- Hostile code fails safely without affecting the worker or other runs:
  infinite loops, memory and stack bombs, giant or cyclic output, fork and
  child-process attempts, refused modules, `process` and prototype tricks on
  returned values, and many concurrent runs.
- From inside a run process, prove that Postgres, Redis, the internet, the
  worker's secrets, the manager's memory and environment, the protocol socket
  and other runs' data are unreachable.
- No run process outlives its task; the manager recovers after run crashes.
- Restart, cancellation and timeout behave like other steps, and a retried
  attempt gets a fresh process.
- The real browser, API, worker and Compose path is qualified before merge.

## Later work

Network access through approved hosts and connections (a capability broker),
Python in the same runner design, more preinstalled libraries, and per-customer
cloud provisioning. Each needs its own review.
