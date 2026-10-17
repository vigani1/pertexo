# Automate Pertexo with a personal API token

Use **Settings → API tokens** in your workspace to create a named token with
only the scopes your script needs. Save the secret when shown: Pertexo cannot
show it again. Tokens default to 30 days and expire within 1–365 days. Up to ten
usable tokens may belong to one person in one workspace.

The token acts as you in that workspace. Its explicit scopes intersect your
current role; membership changes permanently invalidate it, even if your old
role is restored. Logging out or changing your password does not revoke it.
Replace it by creating another, updating your script, then revoking the old one.
Already accepted runs continue after revocation. Last use is approximate, updated
at most once per minute. A token cannot administer credentials, accounts, teams,
triggers or other tokens, edit drafts, replay/recover runs or use operator commands.

Creation requires signing in within the previous five minutes. If automation is
disabled, Settings explains that; metadata and revocation remain available. The
server operator enables `AUTOMATION_TOKENS_ENABLED=true` after applying the
matching migration and binaries. See [the implementation plan](../feature-plans/16-automation-api-and-cli.md)
for rollout and rollback. Restored database backups contain hashes, never the
recoverable raw tokens; keep script credentials separately in your secret manager.
A lost creation response requires checking metadata, revoking that token and
creating a replacement. Replaying its creation cannot recover its secret.

## CLI setup

Build the existing workspace with the pinned Node 24 and pnpm versions:

```sh
pnpm install
pnpm build
pnpm cli --help
```

The CLI lives in `apps/cli`; `apps/ops` holds privileged operator commands only.
The private package includes the `pertexo` executable shape, but is not published
to npm. In this checkout use `pnpm cli`, or the compiled Node entry below for
JSON redirection. Command flags and JSON/help/problem output stay unchanged.
Help/error text retains the existing “automation” name for these HTTP commands.

Supply `PERTEXO_API_URL` and `PERTEXO_API_TOKEN` through your process environment
or CI secret manager. Do not put a token in command arguments, a tracked file,
`VITE_*`, screenshots or shell history. There are no saved CLI profiles. For an
interactive Bash shell, this reads it without echoing or saving the value in
history:

```bash
export PERTEXO_API_URL=https://pertexo.example.com
read -r -s -p 'Personal token: ' PERTEXO_API_TOKEN; printf '\n'
export PERTEXO_API_TOKEN
export WORKSPACE_ID=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
export WORKFLOW_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

Use your real workspace and resource IDs. The explicit workspace must match the
token. Remote origins require HTTPS; plain HTTP is accepted only for
`localhost`, `127.0.0.1` or `::1`. The origin cannot include credentials, a path,
query or fragment. Redirects are refused. The dedicated CLI needs no database,
maintenance or telemetry environment; privileged operator commands keep their
existing independent configuration.

Successful commands write validated JSON to stdout. Failures exit with status 1
and one sanitized JSON problem on stderr (`code`, `detail`, optional `requestId`).
A write whose result is uncertain also includes `outcome: "unknown"` and retry
advice. Input files/requests are capped at 2 MiB, streamed responses at 16 MiB,
and requests at 30 seconds. Files must be regular UTF-8 JSON. There is no automatic
retry or arbitrary endpoint passthrough.

## Commands and matching HTTP calls

Paths below are relative to `/v1/workspaces/$WORKSPACE_ID`. Exactly one Bearer
Authorization header authenticates supported calls; do not mix cookies with it.
The server enforces scopes, validation, rate limits and preconditions shared with
the browser. Request bodies use [the current contracts](../../packages/contracts/src/schemas).

| CLI after `pnpm cli` | HTTP | Token scope |
| --- | --- | --- |
| `workflows list --workspace "$WORKSPACE_ID" [--limit 25 --after CURSOR]` | `GET /workflows?limit=25&after=CURSOR` | `workflow:read` |
| `workflows get --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID"` | `GET /workflows/$WORKFLOW_ID` | `workflow:read` |
| `workflows draft --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID"` | `GET /workflows/$WORKFLOW_ID/draft` | `workflow:read` |
| `workflows versions --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID" [--version UUID --limit 25 --after CURSOR]` | `GET /workflows/$WORKFLOW_ID/versions` with the corresponding query | `workflow:read` |
| `workflows export --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID" --body export.json [--etag "$DRAFT_ETAG"]` | `POST /workflows/$WORKFLOW_ID/export` | `workflow:read` |
| `workflows import-preview --workspace "$WORKSPACE_ID" --body preview.json` | `POST /workflows/import/preview` | `workflow:create`; `connection:read` if bindings exist |
| `workflows import --workspace "$WORKSPACE_ID" --body import.json --key deploy-import-1` | `POST /workflows/import`, `Idempotency-Key: deploy-import-1` | same as preview |
| `workflows publish --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID" --etag "$DRAFT_ETAG" --key deploy-publish-1` | `POST /workflows/$WORKFLOW_ID/publish`, both headers | `workflow:publish` |
| `runs start --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID" --body run.json --key deploy-run-1` | `POST /workflows/$WORKFLOW_ID/runs`, `Idempotency-Key: deploy-run-1` | `run:start` |
| `runs list --workspace "$WORKSPACE_ID" [--workflow UUID --limit 25 --after CURSOR]` | `GET /runs` with the corresponding query | `run:read`; also `workflow:read` for workflow names |
| `runs get --workspace "$WORKSPACE_ID" --run "$RUN_ID"` | `GET /runs/$RUN_ID` | `run:read`; also `workflow:read` for workflow names |
| `runs cancel --workspace "$WORKSPACE_ID" --run "$RUN_ID" [--body cancel.json]` | `POST /runs/$RUN_ID/cancel` | `run:cancel` |

List results contain `items` and an opaque `nextCursor`. Pass that cursor unchanged
as `--after`, retaining the same filters and page size. Limits are 1–100. An exact
`--version` lookup cannot be combined with `--after`. The CLI intentionally exposes
this bounded set of list options; HTTP supports the remaining documented filters.

`workflows draft` includes the validated HTTP `ETag` as an additional `etag`
property in its CLI JSON, alongside the unchanged draft response fields. Keep the
quotes as part of that opaque value; never synthesize an ETag from a revision.
This is command output metadata, not another stored workflow format. With curl,
the same value comes from the HTTP response header.

A curl equivalent helper keeps the secret out of curl's command arguments. It
passes a header on stdin, does not send cookies or follow redirects, and writes
the API's JSON response. These examples use Bash and your configured HTTPS origin:

```bash
api() {
  printf 'Authorization: Bearer %s\n' "$PERTEXO_API_TOKEN" |
    curl --silent --show-error --fail-with-body --header @- \
      --header 'Accept: application/json, application/problem+json' "$@"
}
BASE="$PERTEXO_API_URL/v1/workspaces/$WORKSPACE_ID"
api "$BASE/workflows?limit=25"
api "$BASE/workflows/$WORKFLOW_ID"
api --dump-header draft-headers.txt "$BASE/workflows/$WORKFLOW_ID/draft" > draft.json
api "$BASE/workflows/$WORKFLOW_ID/versions?limit=25"
api "$BASE/runs?workflowId=$WORKFLOW_ID&limit=25"
api "$BASE/runs/$RUN_ID"
api --request POST --header 'Content-Type: application/json' \
  --data-binary '{}' "$BASE/runs/$RUN_ID/cancel"
```

A canceled response is a cancellation request/state acknowledgment, not proof
that a running step stopped. Inspect `runs get` until a terminal status. Cancel
is state-idempotent and needs no command key. Start accepts an omitted body as
`{}` (current published version, ordinary default input); use the explicit
reviewed version below when changes must not silently change the intended run.

## Export, review, import and publish

First read and review the source draft and its ETag, or read one exact immutable
version via `workflows versions --version UUID`. An export request contains:

```json
{
  "source": { "kind": "draft" },
  "reviewedGraphDigest": "<64 lowercase hex characters for the reviewed graph>"
}
```

Compute that digest with the existing `portableGraphDigest(graph)` from
`@pertexo/workflow-model`, using the exact reviewed graph. Do not substitute a
file hash, a revision or a different JSON serialization. For version export, use
`"source": { "kind": "version", "versionId": "<reviewed UUID>" }` and omit the
draft ETag. Draft export requires `--etag`; version export rejects it.

To prepare `export.json` from a reviewed CLI `draft.json`, this command runs in
the CLI workspace and uses the public model entry point. Keep the
`etag` from that same draft for `DRAFT_ETAG`:

```bash
node apps/cli/dist/main.js workflows draft \
  --workspace "$WORKSPACE_ID" --workflow "$WORKFLOW_ID" > draft.json
# Review draft.json before preparing the exact source request.
pnpm --filter @pertexo/cli exec node --input-type=module - \
  "$PWD/draft.json" "$PWD/export.json" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { portableGraphDigest } from '@pertexo/workflow-model';
const reviewed = JSON.parse(await readFile(process.argv[2], 'utf8'));
await writeFile(process.argv[3], JSON.stringify({
  source: { kind: 'draft' },
  reviewedGraphDigest: await portableGraphDigest(reviewed.graph),
}));
JS
```

```bash
node apps/cli/dist/main.js workflows export --workspace "$WORKSPACE_ID" \
  --workflow "$WORKFLOW_ID" --body export.json --etag "$DRAFT_ETAG" > manifest.json
api --request POST --header 'Content-Type: application/json' \
  --header "If-Match: $DRAFT_ETAG" --data-binary @export.json \
  "$BASE/workflows/$WORKFLOW_ID/export" > manifest.json
```

The portable manifest keeps the existing `pertexo.workflow` format. Prepare
`preview.json` as `{ "manifest": <that manifest object>, "bindings": [] }`.
Explicit bindings use the existing slot/connection IDs and require
`connection:read`; credential secrets never enter the manifest. For JSON file
redirection use `node apps/cli/dist/main.js ...`
directly; pnpm may also print script banners.

```bash
node apps/cli/dist/main.js workflows import-preview \
  --workspace "$WORKSPACE_ID" --body preview.json > preview-result.json
api --request POST --header 'Content-Type: application/json' \
  --data-binary @preview.json "$BASE/workflows/import/preview"
```

Review `compatible`, `issues`, `truncated` and `connectionSlots` before applying.
Construct `import.json` from the **same** manifest and bindings plus a plain name
and the returned `expectedCompatibilityFingerprint`:

```json
{
  "name": "Reviewed workflow copy",
  "manifest": "<replace with the reviewed manifest object, not this string>",
  "bindings": [],
  "expectedCompatibilityFingerprint": "<exact compatibilityFingerprint from preview>"
}
```

For example, once the preview has been reviewed, build the apply body from the
unchanged input and returned fingerprint using Node (no additional CLI tool):

```bash
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
const input = JSON.parse(await readFile('preview.json', 'utf8'));
const reviewed = JSON.parse(await readFile('preview-result.json', 'utf8'));
await writeFile('import.json', JSON.stringify({
  ...input,
  name: 'Reviewed workflow copy',
  expectedCompatibilityFingerprint: reviewed.compatibilityFingerprint,
}));
JS
```

```bash
pnpm cli workflows import --workspace "$WORKSPACE_ID" \
  --body import.json --key deploy-import-1
api --request POST --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: deploy-import-1' --data-binary @import.json \
  "$BASE/workflows/import"
```

Import returns a new **unpublished** `workflowId`. Review that copy's draft with
`workflows draft`, then publish using its exact ETag. Publishing does not edit
its graph. The response contains the immutable version and `reused` when an
identical version already existed.

```bash
pnpm cli workflows publish --workspace "$WORKSPACE_ID" \
  --workflow "$IMPORTED_WORKFLOW_ID" --etag "$IMPORTED_DRAFT_ETAG" --key deploy-publish-1
api --request POST --header "If-Match: $IMPORTED_DRAFT_ETAG" \
  --header 'Idempotency-Key: deploy-publish-1' \
  "$BASE/workflows/$IMPORTED_WORKFLOW_ID/publish"
```

Prepare `run.json` with the returned version ID and explicit input:

```json
{
  "expectedPublishedVersionId": "<published version UUID>",
  "input": { "value": "example input" }
}
```

```bash
pnpm cli runs start --workspace "$WORKSPACE_ID" \
  --workflow "$IMPORTED_WORKFLOW_ID" --body run.json --key deploy-run-1
api --request POST --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: deploy-run-1' --data-binary @run.json \
  "$BASE/workflows/$IMPORTED_WORKFLOW_ID/runs"
```

The start response acknowledges admission; inspect its `run.id` with `runs get`
until terminal. A version conflict requires reviewing the new publication;
never replace the expected ID automatically. This run uses real workflow effects.

## Retry and failure handling

Retain the original command key, body, manifest/bindings, fingerprint and ETag
while investigating a lost response or `outcome: "unknown"`. Retrying the exact
command with the **same token** reuses its receipt. A changed intent with the same
key conflicts. A new token or browser session has independent receipts: switching
credentials does not safely retry the old command. Read the resulting workflow,
versions or runs before deciding to submit new work.

A 412 draft conflict or 409 reviewed-version/compatibility conflict needs a fresh
review and a deliberately new intent. An authentication error needs a valid token;
scope denials follow the server's existing 403/404 disclosure policy and may look
like an absent resource. Invalid or revoked credentials return generic 401; they
never reveal whether a token exists. Rate limits remain tied to the owner and
workspace as well as the token. Cancellation retries reuse state, not a new run.

Keep the command keys and reviewed files in your deployment records, protect any
sensitive workflow inputs there, and use the JSON code/request ID when asking the
operator for help. Do not copy secrets or Authorization headers into diagnostics.

With a workflow’s [Skip concurrency policy](concurrency.md), manual and API
starts at the workflow limit return HTTP 409 `workflow.already_running`. No run
is created; retry when space is available.
