# Contributing to Pertexo

Pertexo is a personal project, but focused reports and proposed improvements are
welcome. Open an issue before undertaking a large change so scope and
correctness constraints are clear. Security reports must follow
[`SECURITY.md`](./SECURITY.md) and must not be filed publicly.

## Development contract

- Use Node.js 24 and pnpm 11.
- Treat
  [`docs/workflow-platform-backend-plan.md`](./docs/workflow-platform-backend-plan.md)
  and accepted ADRs as correctness constraints.
- Add an ADR before implementing a decision listed in the plan's ADR index.
- Preserve tenant isolation, idempotency, fencing, bounded work, explicit
  unknown outcomes, and secret-safe observability.
- Keep changes coherent and use imperative Conventional Commit messages.
- Never commit secrets, local environment files, generated runtime data, or
  unrelated formatting changes.

Install dependencies with `pnpm install`; it configures the tracked pre-push
hook. Ordinary pushes automatically run `pnpm prepush:check`, covering the
repository's static, unit, and critical-file coverage gates. Run the narrow
tests for the changed behavior while developing. Run `pnpm prepush:full` when
PostgreSQL, Redis, queue, object-store, HTTP, or process behavior changes; it
adds the service-backed integration suite. Document any environment-dependent
check that could not run. `PERTEXO_SKIP_PRE_PUSH_CHECKS=1 git push` is an
emergency escape hatch, not a substitute for the protected GitHub checks.

Pull requests should explain the behavior or invariant being changed, tests that
prove it, operational or migration impact, and any intentionally retained
similar code. Keep generated contracts, implementation progress, runbooks, and
audit evidence synchronized when their source-of-truth checkpoint changes.

Public visibility does not grant a license to use or redistribute this code; see
the repository's licensing note in [`README.md`](./README.md).
