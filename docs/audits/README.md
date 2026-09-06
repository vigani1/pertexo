# Component audit index

This directory contains exhaustive, component-sized implementation reviews. It
supplements rather than replaces the repository-level
[architecture audit](../whole-repository-audit.md) and
[code audit](../code-audit.md): those files explain systemic conclusions, while
these files record evidence down to each production file, callable, test seam,
and consuming application.

These are pinned-tree historical reviews. Original finding narratives and test
results describe the recorded audit commit, even when written in the present
tense. Later remediation tables record subsequent fixes; neither section is a
substitute for the [current implementation tracker](../implementation-progress.md)
or a fresh verification run. Preserve the original evidence rather than rewriting
it to imply that later corrections existed at the audited commit.

## Audit contract

An audit is complete only when it records all of the following for one package
or application:

1. the exact Git commit and tree reviewed;
2. every production source file and its responsibility;
3. every exported symbol and meaningful internal callable;
4. module depth, interface size, ownership, dependency direction, coupling,
   cohesion, and integration seams;
5. correctness, input invariants, error behavior, security, tenancy,
   concurrency, timeout, retry, cancellation, resource lifecycle, performance,
   and observability where applicable;
6. TypeScript precision, naming, control flow, imports, comments, duplication,
   dead code, speculative abstractions, and API ergonomics;
7. every test file, the behaviors it proves, test realism, brittleness,
   uncovered risk, coverage enforcement, and CI execution;
8. compliance with the implementation plan and applicable ADRs;
9. direct consumers and whether the component's promises survive integration;
10. every identified issue, not only a selected “top” list, with evidence,
    severity, classification, remediation, verification, and status.

Line count is inventory evidence, not a quality rule. A long cohesive operation
is not a finding merely because it is long, and a short function is not accepted
merely because it is short. Reviews use the deletion test for abstractions and
judge whether each module presents a small interface that hides substantial,
coherent implementation detail.

### Granular review certification

The audit contract above describes the required destination, but a package is
labelled **granularly certified** only after a reviewer has read the complete
contents of every tracked production, test, fixture, package, and local tooling
file in that component. Certification additionally requires an explicit pass
over every exported symbol and meaningful internal callable, including small
helpers that are not architectural hotspots. Repository searches and automated
inventories support that reading; they do not substitute for it.

For each file, the pass checks responsibility, imports and dependency direction,
callers, public and internal callables, invariants, branches, error and resource
behavior, naming and readability, duplication and reuse, abstraction depth,
test evidence, and any applicable security, concurrency, performance, or
operational concerns. A prior broad audit can remain useful while this stricter
certification is pending, but it must not be represented as equal manual
scrutiny of every line.

## Finding classifications

- **Confirmed defect:** current behavior is incorrect or unsafe.
- **Maintainability improvement:** behavior works, but the implementation makes
  future change or verification unnecessarily risky.
- **Intentional complexity:** complexity is justified and should not be split
  without a demonstrably better design.
- **Continuous control:** currently satisfied, but future changes must preserve
  the invariant.
- **Unverified production assumption:** local code is coherent only if an
  external deployment or operating fact is true.

Severity uses `P0` (release-blocking), `P1` (high), `P2` (medium), and `P3`
(low). A component is not marked complete merely because its tests pass; the
audit distinguishes implementation completion from audit completion.

## Current inventory and review order

Counts use tracked files beneath each component's `src/` and `test/` directories
at tree `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`. Generated `dist/` output is
excluded. Reviews normally proceed from smaller production surfaces to larger
ones, with dependency order allowed to override raw size.

| Component | Production files | Production lines | Test files | Test lines | Audit status |
| --- | ---: | ---: | ---: | ---: | --- |
| `apps/lifecycle-command` | 4 | 331 | 2 | 229 | [Granularly certified](apps/lifecycle-command.md) |
| `packages/rate-limit` | 4 | 403 | 3 | 270 | [Granularly certified](packages/rate-limit.md) |
| `apps/recovery` | 3 | 486 | 2 | 388 | Not started |
| `apps/operator-command` | 3 | 695 | 2 | 251 | Not started |
| `packages/node-catalog` | 5 | 987 | 2 | 1,010 | [Granularly certified](packages/node-catalog.md) |
| `apps/retention` | 5 | 1,181 | 3 | 558 | Not started |
| `packages/observability` | 10 | 1,304 | 10 | 1,309 | [Granularly certified](packages/observability.md) |
| `packages/nodes-core` | 50 | 1,388 | 2 | 478 | [Granularly certified](packages/nodes-core.md) |
| `packages/node-sdk` | 4 | 1,803 | 2 | 967 | [Granularly certified](packages/node-sdk.md) |
| `packages/queue` | 10 | 2,081 | 7 | 1,402 | [Granularly certified](packages/queue.md) |
| `packages/workflow-model` | 10 | 2,475 | 9 | 1,924 | [Granularly certified](packages/workflow-model.md) |
| `packages/contracts` | 18 | 2,890 | 5 | 836 | [Granularly certified](packages/contracts.md) |
| `packages/artifact-store` | 10 | 3,214 | 11 | 3,543 | [Granularly certified](packages/artifact-store.md) |
| `packages/integrations` | 24 | 3,940 | 8 | 2,760 | [Granularly certified](packages/integrations.md) |
| `apps/worker` | 53 | 7,983 | 71 | 21,249 | Not started |
| `packages/workflow-engine` | 40 | 8,484 | 22 | 8,451 | [Granularly certified](packages/workflow-engine.md) |
| `apps/api` | 121 | 14,993 | 74 | 15,480 | Not started |
| `packages/database` | 140 | 33,154 | 135 | 34,433 | [Granularly certified](packages/database.md) |

The inventory is a snapshot, so each later audit must refresh its own counts and
pin its own reviewed tree. Application audits include their package-facing
composition seams; package audits include all direct application consumers.
