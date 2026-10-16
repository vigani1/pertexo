# ADR 082: Code steps run in single-use isolated Node processes

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
384 MiB of virtual-memory headroom to the heap setting. Container capacity
reserves that full per-process bound plus manager and replacement headroom.
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
Python and cloud provisioning remain separate reviewed work.
