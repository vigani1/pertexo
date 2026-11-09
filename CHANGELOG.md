# Changelog

Each release says what changed for someone running Pertexo, and what they have
to do to upgrade. See [Upgrading](docs/operations/upgrading.md). Versions follow
`vMAJOR.MINOR.PATCH`; until `v1.0.0`, any minor version can need steps of its
own.

## Unreleased

- Row security uses indexed UUID workspace comparisons. Cross-workspace scanners
  use the maintenance login with BYPASSRLS; owner and maintenance policies and
  FORCE are removed. Deploy provisions the role before migration 0117, failing
  closed if the grant fails. Custom deployments must grant maintenance BYPASSRLS
  as a superuser before migrating; see the single-server upgrade guide.

## v0.1.0 - 2026-10-31

The first release anyone can install.

### Added

- x86-64 and ARM64 images for every merged commit, and tags for releases.
- `deploy.sh vX.Y.Z` and `deploy.sh latest`.
- Alerts: `check.sh` and its timer, and a backup heartbeat.
- A one-command quick try for one machine.
- A runbook for any Linux server, plus pages for upgrades, recovery, keys, mail
  and operator commands.

### Changed

- `generate-secrets.mjs` now defaults to self-managed encryption keys.
- `/health/ready` now proves the database can store new data.

### Fixed

- A first deploy as the non-root login no longer fails with unreadable files.
- A restarted API no longer leaves signed-in people on a 502.
- SMTP with a login no longer crashes the worker on every message.

### Upgrading

There's nothing to upgrade from: this is the first release. Follow
[the runbook](docs/operations/single-server.md) for a new install.
