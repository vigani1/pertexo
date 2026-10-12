# Single-server beta

Implementation is in progress under [the plan](../feature-plans/single-server-beta.md)
and ADR 071. RustFS replaces SeaweedFS after real-provider qualification. First launch and provider smoke tests require the
owner's accounts (slice 6).

## Prepare Ubuntu 24.04 ARM

Use one Ampere A1 instance and attach its persistent disk. Allow TCP 22 only
from the operator's address; allow public TCP 80 and 443 in the Oracle VCN
security list. Do not expose database, Redis or storage administration ports.

Install Docker Engine and the Compose plugin using the
[official Ubuntu repository instructions](https://docs.docker.com/engine/install/ubuntu/).
Check `uname -m` returns `aarch64` and `docker compose version` succeeds. Use a
dedicated `pertexo` Unix login with SSH keys and access to Docker. Docker access
is equivalent to root; do not grant it to application users. Disable password
and root SSH login after verifying a second key-authenticated session.

Oracle Ubuntu images can also have iptables REJECT rules. Inspect
`sudo iptables -L INPUT --line-numbers -n`, insert ACCEPT rules for TCP 80 and
443 **before** the REJECT rule, and persist them with `netfilter-persistent`.
Keep the SSH rule while changing the firewall. Docker-published ports can
bypass UFW, so only Caddy publishes ports in Compose; verify from outside the
server that 3000, 5432, 6379, 9000, 9001 and storage administration are closed.
Enable Ubuntu unattended security upgrades and plan for reboot downtime.

Create `/opt/pertexo`, owned by the deployment login, mode 700. Clone the
repository into `/opt/pertexo/repository`. Leave that checkout for control
scripts; `deploy.sh` extracts each chosen commit into `releases/<commit>`.
Persistent Compose volumes belong to the stable `pertexo-beta` project. Never
run `down -v` on a serving installation.

## Configure once

Copy `infrastructure/single-server/.env.production.example` to
`/opt/pertexo/.env.production`, mode 600. Use Node 24 to run the generator on a
trusted machine, or run it with the pinned runtime image and a read-only bind
mount of the source file. Append its output once, without displaying it in
shared terminals or logs. Fill the owner-supplied public origins, Resend and
AWS KMS credentials. Keep the real environment outside Git and in secure owner
custody for recovery. Regenerating encryption keys makes retained tokens
unreadable; recovery also needs the original managed KMS key.

`PUBLIC_WEB_ORIGIN` and `ARTIFACT_STORE_ENDPOINT` must be distinct HTTPS origins
on port 443. Point both DNS names at the server before launch. Caddy obtains
public certificates; private network aliases make API and worker reach files
through that same public name and certificate. The ephemeral pinned `rc` client
creates the bucket, restricts its CORS to the app and binds separate application
credentials to a bucket-only policy. The console is disabled and Caddy blocks
public admin paths. Do not put an internal hostname
in the artifact endpoint: it is embedded in browser presigned links.

The private subnet is `172.30.42.0/24`; select a server without an overlapping
network. Secure cookies, durable mail and production mode are fixed in Compose.
Optional provider pairs and previous application key rings are read from the
same environment. OTLP is optional for this beta; logs remain active. The paid
ECS definitions still supply their collector endpoint.

Generated configuration is placed in the private `/opt/pertexo/state`
directory. Compose reads dotenv as data; scripts never source the secret file.

## Deploy and recover a release

After every CI gate and ARM publication succeeds for a main commit:

```sh
/opt/pertexo/repository/infrastructure/single-server/deploy.sh <full-40-character-commit>
```

The command holds an exclusive operation lock, fetches main, verifies commit
ancestry, pulls both immutable commit tags, checks ARM/revision labels and
validates deployed configuration with the actual application parsers. It starts
private data services, stops serving writers and public ingress, completes the
one-shot migration, and waits for API, worker and web health before recording
`state/current`.

If the release applied no migration and fails health, it returns to the previous
release automatically. If migration changed the database, failed partway through,
or an earlier attempt has an unresolved migration fence, it leaves serving
stopped and requires a forward fix. Do not remove `state/migration-fence` to
force rollback. The fence persists across retries; a second attempt seeing the
migration head does not make a changed database safe for the older image.

Use an approved earlier commit with the same schema for an intentional rollback
through the same command. Never roll an image back across a schema change.
A successful command confirms container health, not an external HTTPS smoke
run. Check Caddy logs and perform the owner-assisted smoke tests before inviting
any beta users.

Images must be readable by the server. Commit-tagged packages are currently
publicly readable; if registry visibility changes, resolve it before deployment.
No registry password is embedded in this stack.

## Logs and operator commands

Select the recorded release before using Compose so images match the running
version:

```sh
export PERTEXO_BETA_ROOT=/opt/pertexo
source /opt/pertexo/repository/infrastructure/single-server/common.sh
select_release "$(cat /opt/pertexo/state/current)"
compose ps
compose logs --tail 100 api worker proxy
compose --profile ops run --rm --no-deps \
  -e OPERATOR_COMMAND_TYPE=operator.status \
  -e OPERATOR_COMMAND_ID=<new-uuid> \
  -e OPERATOR_ACTOR_REF=<operator-reference> \
  -e OPERATOR_WORKSPACE_ID=<workspace-uuid> \
  -e OPERATOR_REASON='Investigate beta workflow' ops
```

The ops CLI receives command fields as environment variables. Refer to the
existing operator runbooks for mutation commands, dry-run fields and evidence;
never run it as the bootstrap superuser. Containers rotate json-file logs at
10 MB with three retained files each.
