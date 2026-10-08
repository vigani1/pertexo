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

Install dependencies with `pnpm install`; it configures the pre-push hook, which
runs `pnpm prepush` (formatting, typecheck, and lint and unit tests for changed
packages). CI runs every suite on the pull request. Run `pnpm test:integration`
locally when PostgreSQL, Redis, queue, object-store or HTTP behavior changes.

Pull requests explain the behavior being changed, the tests that prove it and
any migration impact. When code moves or is deleted, the description lists what
moved where and what was removed, and why. Keep generated contracts and runbooks
in sync with the code.

Public visibility does not grant a license to use or redistribute this code; see
the repository's licensing note in [`README.md`](./README.md).
