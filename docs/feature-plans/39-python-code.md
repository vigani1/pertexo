# F39 — Python in the Code step

Owner decisions accepted 2026-10-22. Extends F20 and amends ADR 082; F21 stays
on hold. One Code step, runner, socket protocol and shared instance budget.

## Decisions and rules

- `core.code@1` keeps config version 1 under ADR 069. Add optional `language`:
  `javascript` (also the meaning of an absent field) or `python`. Existing source,
  timeout, mapping, pins, publication and safe-retry rules remain authoritative.
- Python is synchronous function-body source with `input` and `_vars` arguments.
  Return ordinary JSON values. No asyncio, network or credentials. Non-finite
  numbers, non-JSON objects and values outside the existing JSON/retained-output
  bounds fail with `code.output_invalid`. Python integers must fit JavaScript's
  exact integer range so transport never silently changes their value.
- Pin GIL-enabled CPython **3.15.1**, without JIT or pip, built from the official
  source archive with its SHA-256 checked. This is the current stable expedited
  security release as of 2026-10-22. The release fixes bundled certificate data;
  this runner has no pip or network. Check the upstream security advisory feed
  and existing security gates before landing. Sources: [release](https://www.python.org/downloads/release/python-3151/),
  [PSF advisories](https://github.com/psf/advisory-database).
- Keep the existing image and native launcher. Python inherits the same UID,
  descriptors, syscall allowlist, no-network/read-only policy, CPU/data/address
  space limits, RSS supervision, cancellation and reap-before-slot-reuse fence.
  No privileged work or evaluation in the manager. No extra service or protocol.
  Use Python's trusted `runpy.run_path` bootstrap: direct script startup tries
  `ioctl(FIOCLEX)`, which the existing filter refuses. Normal module/file reads
  work without adding that syscall operation to the allowlist.
- Keep JavaScript's unused warm processes. A Python task reserves that same
  capacity slot, reaps its unused JavaScript process, then starts one Python
  process at the same UID. Release kills and reaps whichever process owns it
  before replacement. There is no per-language pool or doubled concurrency.
- The existing task envelope carries the language field. Existing result,
  greeting, diagnostics, worker validation and private-console caps apply.
  `print()` is captured on stdout; result frames use the private descriptor.
  Source positions are relative to the user's body, including syntax errors.
- Import restrictions are usability and defense in depth, never the security
  boundary. Preload trusted dependencies before installing the user import
  policy. Allow json, math, statistics, datetime, time, zoneinfo, re, decimal,
  fractions, itertools, functools, collections, string, textwrap, hashlib,
  hmac, base64, uuid, random, urllib.parse, html, csv and io. Also allow `_strptime`:
  datetime's C parsing/formatting methods import it and time through the caller's
  import hook. io provides ordinary in-memory CSV buffers; kernel write refusal
  still applies to its file operations. Include OS tzdata.
  Refuse other imports clearly, including os, sys, subprocess, socket, ctypes,
  threading, multiprocessing, importlib, pickle and asyncio. Trusted stdlib
  dependencies do not make those modules available for direct user imports.
- Keep `CODE_RUNNER_PACKAGES` for JavaScript. Add
  `CODE_RUNNER_PYTHON_PACKAGES`, an empty-by-default JSON array of Python import
  names, to the same settings owner, greeting comparison and deployment wiring.
  Administrators install extras only in a custom image. No third-party Python
  package is included. Local process mode uses the same pinned interpreter and
  remains explicitly weaker and forbidden on deployed workers.
- Shared SDK owns language/settings/task types and common source bounds;
  nodes-core owns Code validation/execution. Browser and authoring keep the
  existing JavaScript parser. Python publication validates source bounds only;
  the editor grammar reports local syntax issues without executing, and the
  runner's compiler gives the authoritative precise error at preview/run time.
  This avoids introducing a second server parser or executing during validation.
- The existing lazy CodeMirror field gains Python highlighting/grammar errors.
  Language is a normal step control; changing non-empty code requires explicit
  confirmation and preserves it for editing/undo, rather than translating or
  silently deleting source. Hints use `_vars` for Python and `$vars` for JS.
  Keep focus, diagnostics, read-only state, theme tokens and phone layout.

## Ownership and delivery

| Slice | Changes | Status |
| --- | --- | --- |
| 1. Runtime and isolation | SDK language/settings, Code boundary and worker forwarding; Python task implementation in `apps/code-runner/python/`; same native launcher/pool; pinned image build and existing image qualification on AMD64/ARM64; ADR 082 | Merged [#465](https://github.com/vigani1/pertexo/pull/465); both architectures qualified |
| 2. Editor, guide and qualification | Existing Code inspector and CodeMirror language compartment; confirmation; examples and custom-image docs; function-body fidelity and diagnostic coordinates; mocked and real browser journeys in both themes at desktop/990/phone | Implemented in this PR; merge requires green CI |

Each slice is one PR with Moved, Removed, Lines and Test plan sections. Run the
full pre-push hook. Work on useful independent qualification/docs while CI runs;
fetch and update against current main immediately before each rebase merge.
Moves, if needed, are separate buildable commits. No history rewriting.

## Acceptance and evidence

- Existing JavaScript tests and saved configs pass unchanged. Python previews
  and published runs use the same worker capability. Test inputs, variables,
  imports, timezone data, print caps, syntax positions, non-JSON/non-finite and
  oversized output, timeout, cancellation, isolation and settings mismatch.
- Existing image checks exercise hostile Python alongside a healthy task:
  refused imports plus independent kernel probes with the import policy absent
  for os/subprocess/socket/ctypes, file writes, fork/thread bombs and native/heap
  memory/CPU exhaustion. Run on both architectures using existing CI jobs.
- Measure minimum usable RLIMIT_DATA headroom with the real required modules,
  and measure image bytes before/after. Keep JavaScript's measured bounds;
  tighten Python only when measurement proves the full standard-library path.
  Record numbers here before slice 1 lands.
- Browser: choose Python, cancel/confirm language switch, parse a syntax error
  without execution, preview valid source and diagnostics, save/reload/publish
  and run. Check keyboard and phone, light/dark, desktop and 990 px pane.
- Lint, strict types, unit tests, mocked e2e, relevant native worker/API tests,
  real browser journey, existing image security/qualification gates and full
  actual pre-push hook. Never describe process-mode checks as hardened proof.

## Later

Third-party packages in the standard image, asyncio, network access, notebooks,
another service/protocol and other runtimes are outside this feature.

## Runtime evidence (2026-10-22)

- Official source SHA-256:
  `673ae7232d84c894729882c8257d300ef2d26523911bfd3917ec8ce7f526f99b`.
  Checked 195 PSF Python advisories at database commit
  `cd896b6fd6d0ae3fcf79603cab0c838467eb549e`: none affects 3.15.1.
  The normal production npm audit also reports no known vulnerabilities.
- Native ARM64 production-image qualification passes the unchanged Node checks,
  independent Python kernel probes, bounded thread creation, hostile imports,
  CPU/heap/native-memory bombs beside healthy tasks, transport and hard restart.
  The existing AMD64 image job runs the same assertions before merge; the
  existing ARM64 publishing job repeats them after merge. No CI job is added.
- AMD64 PR CI also passed the full hardened qualification. Required modules
  loaded at **32 MiB RLIMIT_DATA**, **19,832 KiB peak RSS**, confirming zero extra
  startup headroom on both architectures.
- At the minimum setting, required modules and Europe/Paris timezone data load
  under **32 MiB RLIMIT_DATA (zero extra headroom)**, with **18,544 KiB peak RSS**
  on ARM64. This measures module/startup headroom, not a promise that arbitrary
  user allocations fit. Keep the shared launcher bounds unchanged, including
  JavaScript's measured 768 MiB native headroom and the existing RSS monitor.
- Same-revision ARM64 runtime image, measured with `docker image inspect`:
  **158,855,161 → 174,152,993 bytes**, **+15,297,832 bytes (14.6 MiB)**. The baseline
  uses main's Dockerfile with the same application/dependency tree. Strip build
  symbols, static libraries, headers, pip and duplicate optimized bytecode from
  Python's runtime distribution. GIL enabled; JIT unavailable, verified in-image.
- Local runtime tests: 72 passed, including Unicode output/console bounds,
  exact syntax positions, old JavaScript behavior, invalid administrator extras,
  cancellation and shared capacity. SDK, Code executor, worker handshake and API
  publication tests pass; strict types, lint, architecture and contract checks
  pass. Existing OpenAPI lint warnings are unchanged.

## Editor evidence (2026-10-22)

- One scoped language control owns confirmation; the draft remains the source
  of truth. CodeMirror reconfigures the existing view and reuses its incremental
  Python grammar with a bounded parse budget. No evaluation during editing.
- Qualification found that text indentation changes multiline string values.
  The runner wraps CPython's parsed statements in a function AST instead; source
  content and body-relative locations survive unchanged. Unicode byte offsets
  are converted to the editor's UTF-16 columns, and user-raised SyntaxError uses
  its runtime location. Three regression cases failed before the fix and pass
  afterwards; standard datetime/CSV and bounded blocking-wait cases bring the
  total to 77 Code process tests. A hardened ARM64 probe also passes.
- Both themes pass at 375, 990 and 1440 px in six mocked browser cases and the
  real API/worker journey. Real previews exercise a CPython syntax error and
  a successful transformation; the published run reads the captured variable
  revision, uses timezone data and returns the expected JSON/private diagnostics.
  Existing JavaScript behavior passes in the same real-browser run.
- The existing `live-1` browser job installs the pinned CPython for its separate
  development-process runner; no job or production service is added.
- React Doctor reports **98/100, no diagnostics** after grouping language
  presentation and confirmation with their owners. No rule suppression.
- Full web verification passes **1,457 unit tests** and **334 mocked browser
  cases** (including Firefox/WebKit smoke tests), with two local workers to
  keep this busy host within its resources. No assertions or timeouts changed.
