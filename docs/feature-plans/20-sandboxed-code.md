# F20 — Code step

Status: slice 1 merged (#321); slice 2 implemented; owner decisions approved on 2026-10-16.
Updated: 2026-10-16. [Roadmap](../product-roadmap.md).
Decision: [ADR 082](../adr/082-isolated-code-tasks.md).

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
- **One runner design for every install.** Production self-hosters get the same hardened
  runner the default Compose setup ships. Development-only process mode is
  explicitly weaker and refused by deployed workers before sending run data.
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
  its own command. A small Linux launcher is compiled in the existing image
  build; the application otherwise keeps the current TypeScript build. It must not depend on the database, queue, integrations or
  any credential code; extend the module-import check to enforce this.
- A Compose service `code-runner`:
  - `network_mode: none`;
  - read-only root filesystem, tmpfs `/tmp` (noexec);
  - `no-new-privileges`, all capabilities dropped except those needed to start
    run processes as other users and terminate them (`SETUID`, `SETGID`, `KILL`);
  - memory and CPU limits derived from the code-step settings;
  - `ipc: none`, a protected manager OOM priority, bounded descriptors and
    per-slot thread limits;
  - no shared secret environment: it must not use the shared environment
    anchor; it gets only its own limit settings.
- The worker talks to it over a Unix socket on a volume shared only by the
  worker and the runner. The protocol uses bounded JSON messages: task in, one
  result out, after a small ready/busy greeting. The worker checks hardened
  mode before sending input; busy clients wait within the attempt budget.
  Task messages have a 3 MiB wire ceiling (two separately bounded input/variable
  values plus escaped code); result messages have a 2 MiB wire ceiling. Each
  protocol input/output stays within the SDK 1 MiB, depth-64, 10,000-member
  envelope. The worker additionally enforces the existing retained inline JSON
  limit of 256 KiB, using the existing storage validator; this is not a new format.
  The socket is reachable by the worker, not by run processes.
- The runner's managing process keeps a small pool of pre-started, unused run
  processes. Each run process executes exactly one task and is then discarded,
  so no state, module cache or memory crosses runs or workspaces.
- Run processes:
  - run as a different unprivileged user from the managing process, one per
    concurrency slot, so a run can't read, signal or trace the manager or
    another run;
  - the Linux launcher permanently drops UID/GID, supplementary groups and
    capabilities before exec. It installs an inherited seccomp allowlist:
    no new sockets (including loopback/abstract Unix sockets), filesystem
    writes/mutations, IPC, tracing or child processes; only Node runtime threads
    are allowed. Missing enforcement refuses hardened startup;
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
  limits; console output also has a line cap (64 KiB and 200 lines, with visible
  truncation). Logs and bounded error details are separate private attempt
  diagnostics, not step output. Preserve them for successful and failed
  runs/previews under existing reader authorization, detail expiry and purge.
  No diagnostics enter safe failure summaries, notices, audit or email.
- When Code steps are off, publishing a workflow with one is refused, and a run
  that reaches one fails with `code.disabled`.
- When no slot is free, the attempt waits within its lease and otherwise
  retries through the normal safe retry path.

## Implementation owners and qualification decisions

- `node-sdk/code` owns the browser-safe source parser, bounds, protocol and
  diagnostics contract; `nodes-core/data/code` owns `core.code@1`. Pin acorn
  8.19.0, lodash 4.18.1 and dayjs 1.11.23; check production advisories.
- `apps/code-runner/{process,execution,transport}` owns single-use processes,
  module policy, hostile-value encoding, console capture and the socket. It
  imports no application, credential, database, queue or integration module.
  Register Docker-executed probe entries and the two deliberately dynamic npm
  dependencies in the existing Knip configuration; real-process tests load both
  packages and the production advisory check still covers them.
- Worker attempt and preview capability factories use their already captured
  variable values. Never read the current workspace variables at execution.
  A retry/recovery/replay therefore keeps its immutable revision.
- Extend existing authoring validation for syntax, enabled state and maximum
  timeout; expose public instance limits through the existing catalog response.
  No code executes during authoring. The worker enforces the same settings.
- Private diagnostics use the existing attempt/preview persistence and reader
  paths, with an additive migration. Use existing fenced completion and
  retention; no logging subsystem or new stored value format.
- The production image's worker is UID/GID **10001**. Its group owns access to
  the root-owned socket directory; run slots use separate IDs 20000–20015 and
  no supplementary groups. A slot is reused only after its old process exits.
- Docker's `none` network keeps loopback, and Node explicitly does not guarantee
  safety against malicious code. The launcher closes those gaps at the kernel
  layer; the permission model and clean globals are defense in depth. This is
  the closest implementation preserving every Acceptance guarantee, in the
  same approved runner service. The cached-image prototype refused network,
  filesystem writes, fork, manager signaling and manager files/memory/environment
  even with Node's permission model deliberately absent.
- A data-memory rlimit at the heap setting alone prevented Node from booting
  in the pinned ARM image. Reserve 768 MiB of virtual data headroom in addition
  to the configured heap, and enforce that sum as a hard `RLIMIT_DATA` before
  Node starts. AMD64 V8 precommits a 512 MiB executable code range (ARM64
  uses 256 MiB), so the shared headroom accommodates both. The default
  container ceiling is 2,912 MiB; idle memory is not reserved. Keep the planned heap plus container bounds,
  supplement them with active-task RSS checks, reserve headroom and protect the
  manager from OOM selection. Each child has OOM priority 1000; kernel write
  fences prevent lowering it. Qualify buffer/ArrayBuffer, heap and stack bombs
  beside a healthy task. Do not claim the heap flag alone bounds native memory.
- Use the existing development launcher, beta preparation/deploy/rollback/
  restore owners and image CI jobs. Derive container memory, CPU and PID limits
  from settings; validate hardening before marking a runner ready. Qualify the
  native launcher and production image on both existing image architectures.
- Qualification keeps the approved development/CI browser path separate from
  the hardened image proof: the live browser job builds the runner alongside its
  API/worker dependencies, then authors, previews, publishes and
  runs through a real worker and separate runner process. Both existing image
  jobs exercise the production worker client against the hardened service,
  hostile tasks beside healthy tasks, independent OS probes without Node
  permissions, cancellation and a hard manager restart. The Compose test resolves
  the actual service configuration and verifies its isolation and secret fence.
- Retained outputs keep the database’s existing 256 KiB limit and Unicode rules;
  an oversized result or unsupported text fails with `code.output_invalid` and
  a useful private diagnostic. The runner's 1 MiB transport ceiling does not
  expand persisted run data. Private logs/error messages show NUL as a visible
  escape and replace lone surrogates, staying inside the same log/line bounds.
  The Linux filter also refuses shared memory mappings so `RLIMIT_DATA` cannot
  be bypassed through shared writable pages.
- Existing publications whose explicit timeout exceeds a subsequently lowered
  instance maximum fail with `code.disabled` until the step limit is lowered.
  Workers refuse mismatched runner settings before transmitting private input.

Sources: [Node permissions](https://nodejs.org/download/release/v24.19.0/docs/api/permissions.html),
[Docker none network](https://docs.docker.com/engine/network/drivers/none/),
[Linux seccomp](https://docs.kernel.org/userspace-api/seccomp_filter.html).

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

Slice 2 implementation choices (2026-10-16):

- Lazy-load the Code setup and CodeMirror 6 only for a selected Code step.
  Keep source in the existing draft; the editor owns selection and view state.
  External undo, node switches and read-only mode synchronize without remounting
  on each keystroke. Tab keeps its normal focus behavior.
- Use the browser-safe `node-sdk` source parser and limits through its reviewed
  root entry only; the Node-only server entry remains forbidden in the browser.
  Show syntax errors from the same parser used by publication, without evaluation.
- Pass the existing catalog's instance settings to setup controls. Show the
  effective default timeout, maximum, heap and concurrency, and constrain the
  timeout field to that maximum. An unavailable snapshot is stated plainly.
- Share one plain-text diagnostics view between previews and run step details.
  Safe preview diagnostics attach at fenced completion without requiring an
  external-dispatch marker; Code does not contact a provider. Run readers fetch
  the existing scoped endpoint only for completed Code
  attempts; cache by attempt and status. Pinned/reused outputs do not invent logs.
- Give memory-bomb probes a separate ten-second budget so slow ARM garbage
  collection reaches the memory fence; the loop probe retains its one-second
  deadline and the memory-code assertion remains strict.
- Qualify editing, live syntax errors, keyboard focus, external undo, previews,
  pins, published execution, private logs/errors and narrow-screen layout through
  the existing browser tests. Keep tests and documentation within this slice.

## Slices and status

| Slice | Status |
| --- | --- |
| 1. ADR, runner app and Compose service, protocol, `core.code@1` runtime through the worker, settings, hostile-code and isolation suite | Merged (#321) |
| 2. Editor: code field, syntax errors, test with previews and pinned data, logs, limits display, guide | Implemented (editor PR) |

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

Python in the same runner is delivered by
[F39](39-python-code.md), with the owner-approved amendment to ADR 082.
Network access through approved hosts and connections (a capability broker),
more preinstalled libraries and per-customer cloud provisioning remain later
work. Each needs its own review.
