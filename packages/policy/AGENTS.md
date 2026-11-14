# @pertexo/policy

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The product's access and lifecycle rules as plain data and pure functions:
roles and capabilities, API token scopes, member-management transitions,
workspace status lists and the auto-pause ceiling. It is browser-safe and
depends on nothing. `contracts`, `workflow-model`, `database`, `core`, the API
and the web app read it so a grant is decided in one place.

It never does I/O, reads configuration, or knows about HTTP, SQL or React.

## Layout

One entry, `src/index.ts`, and one file per policy at the root:

- `authorization-policy.ts`: roles, the capability-to-roles table, token
  scopes and the views derived from that table.
- `membership-policy.ts`: who may change, remove, suspend, invite or hand
  ownership to whom (ADR 037, 038, 042, 047).
- `workspace-status-policy.ts`: the named status lists a flow passes to
  `withWorkspaceAccess`.
- `auto-pause-policy.ts`: the auto-pause threshold ceiling (ADR 056).

## Where new code goes

- A new capability: add it to `capabilityRoles` in `authorization-policy.ts`;
  every derived list follows.
- A new member action: one `can…` function in `membership-policy.ts`.
- A new status list: a frozen constant in `workspace-status-policy.ts`, added
  to `WorkspaceStatusList` only if flows pass it to `withWorkspaceAccess`.
- A new policy area: a new `<subject>-policy.ts` at the root, exported from
  `index.ts` and added to the root allowlist in
  `infrastructure/checks/package-structure.mjs`.

## Defaults and config

No configuration. Its one limit, `MAX_AUTO_PAUSE_THRESHOLD`, lives in
`auto-pause-policy.ts`.

## Rules

- Policies are data plus pure functions; the database stays authoritative for
  current state, and callers pass that state in.
- Other views (per-role lists, presentation order) derive from
  `capabilityRoles`, never restate it.

## Exceptions

- The policy files sit at the `src` root with no sub-area: the package is one
  small area, and a folder per four files would add navigation only.

## What guards it

- `pnpm --filter @pertexo/policy test` checks every role's capabilities and
  each membership transition; `workspace-status-policy.test.ts` checks the
  built entry's status lists.
- `pnpm check` runs the package structure, naming and environment checks.
