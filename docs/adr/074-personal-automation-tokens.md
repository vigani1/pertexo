# ADR 074 — Personal workspace automation tokens

- **Status:** accepted
- **Date:** 2026-10-14
Feature: [F16](../feature-plans/16-automation-api-and-cli.md)

## Context

Scripts need limited workflow/run access without browser sessions or operator DB
credentials. Existing users, workspace roles and membership revisions define
ownership. Removing/changing membership must not leave credentials alive or enlarge
a grant. The owner authorized F16 planning and implementation after F09/F24.

## Decision

An API token belongs to one Pertexo account and workspace, grants explicit existing
capability scopes, expires within 365 days and records membership revision at
issuance. PostgreSQL authentication checks digest and current owner/workspace/member
state. Any membership revision change permanently invalidates it, even after
rejoining/reactivation. Shared authorization intersects scopes/current role.
No new workspace or database role.

Use opaque `ptx_1.<workspace UUID>.<token UUID>.<base64url secret>` with 32 random
secret bytes. Store SHA-256 of the complete credential. Public IDs enable forced
workspace RLS lookup but grant no rights. No JWT, recoverable encryption, pepper
key or external identity service. Return raw secret once; never persist it in
command receipts or return it on replay.

Bearer authentication is method-specific on documented workflow/run operations.
It has distinct credential identity, never a fake session. Cookie-only management
requires CSRF and recent sign-in for issuance. Shared use cases enforce scopes.
Token command identity is separate from other tokens/sessions owned by that person.

Verification after committed revocation fails; previously verified requests and
accepted runs may finish. Each request checks storage without auth caching.
Rotation is replacement then revocation. Browser logout/password change does not
silently rotate these independent credentials.

## Alternatives and consequences

Service accounts add ownership/management policy before a concrete requirement;
defer them. JWTs complicate prompt revocation; encrypted recoverable credentials
increase disclosure/backup risk without a recovery need. A global lookup/bypass
role weakens workspace isolation.

Existing membership revisions avoid revocation hooks in every lifecycle command
and prevent grants expanding on upgrades. Any membership change deliberately
requires a new token. Secrets are saved separately and cannot be recovered from
backup/retried creation; lost responses use metadata/replacement. The existing
apps/ops gains a thin HTTP path separate from privileged operator commands.
