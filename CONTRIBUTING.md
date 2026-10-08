# Contributing to Pertexo

Pertexo is a personal project, but focused reports and proposed improvements are
welcome. Open an issue before undertaking a large change so scope and
correctness constraints are clear. Security reports must follow
[`SECURITY.md`](./SECURITY.md) and must not be filed publicly.

## Development contract

- Use Node.js 24 and pnpm 11.
- Follow [`AGENTS.md`](./AGENTS.md), the
  [architecture reset plan](./docs/architecture-reset-plan.md) and the ADRs that
  are not superseded.
- Add an ADR only for a hard-to-reverse decision.
- Preserve tenant isolation, idempotency, fencing, bounded work, explicit
  unknown outcomes, and secret-safe observability.
- Keep changes coherent and use imperative Conventional Commit messages.
- Never commit secrets, local environment files, generated runtime data, or
  unrelated formatting changes.

To run the services, API, worker, and web app locally from `.env.example`,
follow the README's [Local Development](./README.md#local-development) section;
every terminal that runs a pnpm process needs `.env` loaded.

Install dependencies with `pnpm install`; it configures the tracked pre-push
hook. Ordinary pushes automatically run `pnpm prepush:fast`: every static gate
from `pnpm check`, plus lint, typecheck, and related unit tests scoped to the
packages the branch changed (`pnpm prepush:changed`). The protected GitHub
checks run every suite on the pull request. Run `pnpm prepush:check` (or push
with `PERTEXO_PRE_PUSH_FULL=1`) to run the repository-wide unit, critical-file
coverage, and browser probe gates locally. Run `pnpm prepush:full` when
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
