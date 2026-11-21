# ADR 096: Execute pure steps in a coordinator advance

- **Status:** accepted
- **Date:** 2026-11-21
- **Related:** [ADR 006](006-coordinator-checkpoint-and-node-attempt-jobs.md),
  [ADR 007](007-run-node-state-retry-idempotency.md),
  [ADR 012](012-fair-admission-backpressure-entitlements.md),
  [ADR 072](072-failed-step-recovery.md),
  ADR 095 (integration modules)
- **Feature:** [F58](../feature-plans/58-inline-pure-steps.md)

## Context

Every pure step currently goes through an attempt delivery and a coordinator
continuation. Option B reduced transaction setup without removing either hop.
[Option C](../feature-plans/step-transaction-cost.md#options) removes both hops
for steps whose work can be repeated after rollback. PostgreSQL still owns the
run, checkpoint, history and follow-up work under ADRs 005, 069 and 091.

## Decision

**The pinned definition owns the execution class.** A step definition declares
`execution: 'attempt' | 'inline'`. A missing declaration on a legacy version
means `attempt`. Only platform-owned, deterministic, bounded, I/O-free
definitions can declare `inline`. Start with Set, Condition, Switch, Merge,
Filter, Sort and qualifying transforms. Qualify the whole version and every
configuration it accepts. Crypto versions that generate random values, HMAC
with a signing connection, file steps, Code, and steps that wait or dispatch
work stay on the attempt path. The registry checks the registration's origin
from catalog composition, the definition and executor pairing, safe retry
class, absence of connection slots and execution capabilities, and the
capability-free executor registration. All integration modules, including
platform integrations under ADR 095 and future community modules, enter
through an attempt-only registration path. A module's self-declared metadata
cannot change its origin.

**The executor gets values.** The SDK's inline invocation contains bounded
config and mapped input plus the engine's injected `now` snapshot as data.
It returns a bounded result or a typed failure synchronously. The coordinator
invokes the reviewed, platform-owned kernels directly from the pure registry.
The SDK permits only this executor signature for inline registration. Supply
zero host objects, callbacks, clients, connections, artifacts, timers or
randomness sources. Explicit date arithmetic uses the inputs and a
deterministic date API. Validation, mapped input resolution and typed error
translation run in the host using the existing bounded paths. Use the
existing JSONata evaluator and its expression limits there.

**Check the full import closure.** An architecture check in
`infrastructure/checks/`, run by `pnpm check`, walks every module reachable
from each inline executor entry, including through re-exports. The Node
builtin allowlist starts empty because the initial kernels need no builtins.
Reject builtin imports with or without the `node:` prefix, network, database,
filesystem and process packages, and imports from `@pertexo/secrets`,
`@pertexo/database`, `@pertexo/integrations` or the worker. Reject ambient
network, process and timer access, `Date.now`, argumentless `new Date()`,
`Math.random`, crypto randomness, dynamic `import()`, `eval` and the
`Function` constructor. The check has refusal tests for each case. Direct
calls avoid per-advance context setup and serialization. The check enforces
project rules for reviewed built-ins. Node advises against using VM
contexts for untrusted code.
[Node.js VM documentation](https://nodejs.org/api/vm.html#vm-executing-javascript)

**Commit one advance.** Within the current workspace admission and locked-run
transaction, consume the durable observations, use the existing scheduler to
select work, and execute consecutive ready inline invocations in scheduler
order. Feed each outcome and its output into the same completion and
scheduling rules used for an attempt delivery. Keep sequential dependencies
on the transaction-local results. Persist the usual node runs, attempt
numbers, inputs, outputs and completion facts, with one gapless event sequence
and one checkpoint CAS for the entire advance. Inline attempts have terminal
records and no lease or provider dispatch evidence. Write the attempt outbox
for the next admitted attempt-class work, or the coordinator continuation
when immediate work remains. Keep the delivery receipt in the same commit.

Resuming a parked run may take the workspace capacity counter before
scheduling. If the next work is inline, commit the slot reacquisition and
the continuation before running the kernel. The new advance reacquires the
shared workspace fence and the run lock. Its checkpoint and receipt still
commit together with its inline attempts and events.

Before commit, process death, abort or a failed CAS rolls back the entire
advance. Redelivery can recompute the bounded pure work from the previous
checkpoint and durable inputs, with no externally visible effect from the
discarded execution. After commit, redelivery sees the receipt and checkpoint
under the run lock. The stored attempt identities, event sequence and
outbox are already complete. Redis loss uses the existing outbox recovery.

**Bound every advance.** Start with at most 16 inline attempts and a 50 ms
monotonic elapsed budget for inline work, including input preparation and
settlement. Elapsed time counts computation and time spent waiting on
expression evaluation while the run lock is held. Check both limits before
starting another invocation. Give an invocation its existing effective step
deadline, clipped by the run deadline, and a separate stop at the remaining
advance budget. Use the evaluator deadline to interrupt expression evaluation.
Require bounded synchronous work for every accepted kernel configuration and
check the deadlines again on return, before accepting the result. A direct
synchronous call can run past the elapsed budget before that check. A step or
run deadline keeps its usual timeout semantics. If the advance budget expires
during an invocation, discard only that invocation's uncommitted result and
yield from the last settled invocation. If the first invocation cannot finish
within a fresh budget, admit it through the ordinary attempt path to guarantee
progress and preserve its step timeout.
A process shutdown aborts the advance. Keep admission limits independent of
this computation budget. For Each keeps its existing declaration, iteration
ordinals, concurrency and checkpoint bounds. Inline body invocations share
the advance budget across all ordinals. The first rollout stops at the
current iteration-batch barrier and uses the existing continuation if the
next batch is ready.

**Keep the logical history.** Record the usual started and outcome events and
serve them through the existing committed sequence and SSE notification
path. Subscribers may see several steps in a single update. Apply the same
failure classification, `decideRetry`, durable retry due time, failed node
run, failure routes and error workflow rules. A due retry gets its own
numbered attempt and shares the same budget when eligible. Use the existing
test and pinned-sample policies before dispatch selection, with the same
preview and test-suite semantics. Replays resolve the selected version and
recovery reads the same retained attempt and output evidence. Report
committed inline attempt outcomes and durations through existing step metrics,
with actual queue delivery metrics coming from transport.

**Upgrade by definition version.** Changing class adds a new definition
version and retains the old definition and executor. Resolve class using the
published node's existing definition pin. Preserve legacy projection hashes
and existing workflow versions. Already-admitted attempts finish on their
original path. Roll out readers and both executor bindings to all workers
before publishing inline versions. The rollout started with coordinator
execution disabled. After the
[fixed-build qualification](../feature-plans/step-transaction-cost.md#fixed-build-steady-and-rollout-gate),
`WORKFLOW_COORDINATOR_INLINE_STEPS` defaults to `true`. Set it to `false`
to select attempt delivery for newly admitted pure work.
An inline version ships with an attempt binding for the same pure
implementation. Fallback and rollback preserve workflow outputs and leave
queued attempts on their original path.

## Consequences

The coordinator spends bounded compute time under its existing transaction
and run lock. Short pure chains avoid per-step transport while preserving
node-run and attempt history. External work keeps ADR 006's separate
attempt transaction and recovery protocol. The default can change after
the correctness, equivalence, safety and performance gates in F58 pass.
