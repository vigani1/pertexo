# Deploying from GitHub

Optional, and only for someone running their own fork: `deploy.sh` on the server does the
same thing by hand.

## Manual GitHub deployment

The `Deploy beta` workflow runs only through `workflow_dispatch` from `main`.
Supply a full lowercase 40-character main commit SHA. It verifies ancestry and
queries the latest push run of `ci.yml` for that exact SHA; the entire run and
`publish-images` job must have succeeded. A PR check, scheduled run, pending
publisher or previous successful run followed by a failed retry is insufficient.
No deployment follows a push automatically.

First update the server's clean control checkout with `git pull --ff-only origin
main`. Keep these installed scripts trusted and current when applying
operational fixes. They enforce current recovery fences even when deploying an
older image; release images, Compose and configuration parsers come from the
selected immutable commit. The dispatcher delegates ancestry, image identity,
locking, migration and health checks to the same `deploy.sh` used manually.

Generate a dedicated Ed25519 SSH key without a passphrase on a trusted
machine. Store its private half only as repository Actions secret
`BETA_SSH_PRIVATE_KEY`. Restrict the public half in the `pertexo` login's
mode-600 `~/.ssh/authorized_keys`:

```text
restrict,command="/opt/pertexo/repository/infrastructure/single-server/dispatch.sh" ssh-ed25519 <public-key> pertexo-github-beta
```

Keep a separate key for interactive maintenance. The `restrict` option
blocks forwarding, PTY allocation and user SSH rc execution; the forced command
accepts only `deploy <full-SHA>`. See the
[OpenSSH authorized-key documentation](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT).
Do not enable user-controlled environment loading or accept deployment path and
shell startup environment variables in sshd.

Set repository secrets `BETA_SSH_HOST` (DNS name or IP) and `BETA_SSH_USER`
(`pertexo`). Retrieve the server's public host key through your provider's trusted
console or an already verified session. Compare its fingerprint through
that trusted channel, then put its known_hosts line, with the same host name
used by `BETA_SSH_HOST`, in `BETA_SSH_KNOWN_HOSTS`. Hashed known_hosts entries also
work. Do not trust a fresh key scan over the deployment connection as the source
of identity. If a replacement server changes its key, verify and update the
secret explicitly.

The client uses batch public-key authentication, `StrictHostKeyChecking=yes`,
only the pinned known_hosts file, no DNS trust or host-key updates, no agent or
port forwarding, and no user SSH configuration. Temporary key files are mode
600 and removed after success or failure. SSH secrets are available only to the
send step after CI verification. Workflow deployments serialize without
canceling a running command; the server operation lock also excludes backups,
restore and operator mutations.

Run the workflow once and inspect its health result and server logs. A failed SSH
session is not proof of rollback: inspect `state/current` and any migration/restore
fence before retrying.
