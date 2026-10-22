# ADR 082: Code steps run in single-use isolated processes

- **Status:** accepted
- **Date:** 2026-10-16
- **Plan:** [F20](../feature-plans/20-sandboxed-code.md)

The owner approved real Node for JavaScript transforms with allowed built-ins
and installed packages. Execution belongs to a dedicated code-runner container,
reached by workers through a private Unix socket. API processes never execute
code. Each task consumes one previously unused process under a distinct slot
UID and that process must exit before the slot is reused. Inputs, captured
workspace variables, results, logs, code and execution time are bounded.

The container has no network route, secrets or database/queue/integration
modules, a read-only root, private tmpfs, no new privileges and only the
capabilities required to drop identities and terminate children. A Linux
launcher adds irreversible kernel syscall restrictions before Node starts:
no sockets, filesystem writes/mutations, IPC, tracing or process forks. Runtime
threads have a per-UID limit. The socket is accessible to worker group 10001
and the manager, and inaccessible to task identities 20000–20015.

This completes two details absent from the short design: Docker's network-none
mode retains loopback, and Node's permission model explicitly does not provide
a boundary against malicious code. Node permissions, clean globals and a
closed module policy supplement the OS controls. The native launcher uses the
existing image build and runner service. Development alone may use the
explicitly weaker separate-process mode; deployed workers refuse that mode
before sending any task data.

Heap and container limits, native-memory monitoring, per-UID thread limits,
manager OOM protection and task termination isolate resource failures. A data
rlimit equal to the heap cap prevented startup; a hard data limit instead adds
768 MiB of virtual-memory headroom to the heap setting. Container capacity
reserves that full per-process bound plus manager and replacement headroom.
AMD64 V8 precommits a 512 MiB executable code range during startup, twice the
ARM64 reservation; the common bound must accommodate both architectures.
Concurrent heap, Buffer and ArrayBuffer bombs must leave healthy tasks intact. Cancellation, disconnect, timeout and
shutdown reap children; a retry gets another process. No credentials, external
I/O or network broker is exposed, so Code is safe to repeat. Only closed safe
error codes flow to routing and summaries; user diagnostics are run-reader
private data under ordinary run/preview retention.

The rejected approaches remain: vm/vm2 as a security boundary; isolated-vm as
a maintained Node/npm runtime; QuickJS-in-WebAssembly for this full-speed Node
contract; and a fresh container per task for this single-server installation.
A future shared multi-tenant product must revisit isolation rather than
assuming this per-customer instance design is sufficient. Network access,
Cloud provisioning remains separate reviewed work.

## 2026-10-22: Python in the same runner (F39)

The owner approves real CPython 3.15.1, pinned by source checksum, as a second
language of `core.code@1`. Missing language still means JavaScript. Python is
a synchronous function body over mapped `input` and captured `_vars`; it returns
bounded JSON and writes `print()` to the existing private diagnostics. The
existing task envelope adds language; no new socket protocol or stored format
is introduced. See [F39](../feature-plans/39-python-code.md).

Python uses the same manager, single-use process lifecycle, UID slots, native
launcher and inherited syscall allowlist. A Python reservation reaps the unused
JavaScript process before replacing it at that UID. Shared instance capacity,
CPU/data/address-space bounds, RSS supervision, cancellation, read-only mounts
and network refusal apply unchanged. CPython is built with the GIL, without JIT
or pip; OS timezone data supports zoneinfo. No third-party Python packages ship.

The standard-module and administrator-installed-package allowlists are defense
in depth. They cannot be a Python sandbox: trusted modules and introspection
can expose interpreter internals. The kernel/identity/container layer is the
security boundary, exactly as for JavaScript. Independent probes deliberately
bypass import restrictions and exercise os, subprocess, socket, ctypes, writes,
forks and bounded thread creation; resource bombs run beside healthy tasks.
Both image architectures must pass the existing image qualification jobs.
