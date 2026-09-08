# Project Instructions

## Source of truth

- When implementing a planned backend checkpoint, follow
  `docs/workflow-platform-backend-plan.md` as the authoritative implementation
  blueprint and treat `docs/workflow-platform-backend-research.md` as supporting
  research.
- For planned checkpoint work, keep `docs/implementation-progress.md` current.
  Update its summary, checklist, and concrete evidence when the checkpoint's
  status materially changes; never mark a phase complete while required plan
  criteria remain unfinished.
- Create required ADRs before implementing decisions listed in the plan's ADR
  index. Do not create an ADR for a routine fix, refactor, test, investigation,
  or documentation correction that does not introduce an architectural
  decision.
- For work outside a planned backend checkpoint, use the user's request,
  existing contracts, `CONTEXT.md`, relevant ADRs, and current implementation as
  the source of truth. Do not update plan or progress documents unless the work
  changes what they claim.

## Agent skills

- Load skills only when the current task matches them. Do not load every
  available skill preemptively.
- Use `nestjs-best-practices` for NestJS modules, dependency injection,
  controllers, guards, or framework-specific review.
- Use `node` for Node.js runtime behavior, async patterns, streams, process
  lifecycle, logging, testing, profiling, or performance. Preserve Pertexo's
  existing NestJS and TypeScript build configuration; do not introduce native
  TypeScript type stripping or a buildless Node setup unless the user
  explicitly requests it.
- Use `postgres` for PostgreSQL schemas, migrations, RLS, transactions,
  concurrency, query behavior, or connection troubleshooting. Existing Pertexo
  architecture and provider decisions override vendor recommendations in the
  skill.
- Use `diagnosing-bugs` for difficult failures, regressions, or performance
  problems that require reproduction and competing hypotheses.
- Use `domain-modeling` when changing domain terminology, `CONTEXT.md`, or ADRs,
  and `codebase-design` when designing or materially changing a module
  interface or seam.
- Use `improve-codebase-architecture` when the user explicitly requests a
  structural architecture audit or asks to discover and compare codebase-wide
  deepening opportunities. Do not invoke it for routine implementation,
  focused refactoring, or as permission to reopen decisions already settled by
  the plan or ADRs.
- Use `typescript-advanced-types` only for genuinely complex compile-time type
  contracts. Prefer ordinary TypeScript for routine code.
- Use `tdd` only when the user asks for test-first development. Infer an
  established test seam from the plan, ADRs, public contracts, and nearby tests;
  ask only when selecting a seam would create or change a consequential
  architectural contract.
- Use `code-review` only for a fixed-point diff review. A whole-repository audit
  or ordinary implementation check is not a fixed-point review.
- Do not use React, Next.js, TanStack, shadcn, frontend-design, or Prisma skills
  unless those technologies exist in the relevant checkout and task scope.
- Use subagents only for substantial independent work with non-overlapping
  ownership when parallelism is likely to improve speed or coverage after
  accounting for coordination and token cost. Keep tightly coupled decisions,
  cross-package invariants, and final integration with the primary agent.

## Git discipline

- Preserve unrelated and uncommitted user work. Inspect `git status` and the
  relevant diff before handoff.
- Create commits only when the user requests commits or the current task
  explicitly includes completing and recording an implementation checkpoint.
- When commits are authorized, make them as coherent changes become reviewable.
  Do not use a fixed commit count or commit separately merely because several
  files changed. Inspect the staged diff, stage only files belonging to the
  logical change, and run the narrowest relevant verification first.
- Do not commit broken intermediate states. Each commit should build and pass
  the checks relevant to its scope whenever those checks are available.
- Use imperative Conventional Commit messages, such as `feat: add API
  bootstrap`, `test: cover workspace RLS`, or `docs: record execution dispatch
  decision`.
- Never amend, squash, rebase, force-push, or otherwise rewrite existing
  history unless the user explicitly requests it.
- Never include secrets, local environment files, generated runtime data, or
  unrelated formatting changes in a commit.
- Push only when the user explicitly requests a push or previously authorized
  pushing completed checkpoints for the current task. Before an authorized
  push, fetch the remote and confirm the local branch is not behind or
  diverged. Do not push broken, unreviewed, WIP, secret-bearing, or unrelated
  changes.
- At handoff, report any commits created, any push performed, the relevant
  branch/upstream, and remaining uncommitted changes.

## Commit checkpoints

When commits are authorized, use these as commit boundaries once independently
reviewable:

- a repository or package foundation;
- one vertical-slice behavior with its relevant tests;
- a schema migration plus the code that safely uses it;
- a focused refactor with unchanged behavior and passing verification;
- an ADR or documentation decision that changes implementation guidance; or
- a bug fix with its regression test.

Large authorized phases should use multiple coherent commits. Tiny
file-by-file, formatting-only, or checkpoint/WIP commits are not useful unless
the user explicitly asks for them.
