# Author a community integration

A community integration release is a single JSON file. You can create and
check it with the Pertexo server image from the release you intend to support.

## Scaffold and check offline

From a clean author folder, set `PERTEXO_IMAGE` to your local Pertexo server
image tag. Use this shell function to run the image's CLI with a writable bind
mount owned by your local account.

```sh
pertexo() {
  docker run --rm --pull=never --network=none --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=$PWD,target=/author" --workdir /author \
    "$PERTEXO_IMAGE" node /workspace/apps/cli/dist/main.js "$@"
}
pertexo integration init
pertexo integration check
```

`init` creates `integration.json`, `README.md`, and `conformance.json`.
The sample models a read-only Get post action. Replace the sample identity,
origin, and recipes with yours. Use a literal HTTPS origin and set the host
release range to the versions you support. See [ADR 099](../adr/099-community-integration-packages.md)
for the package contract.

`check` validates the artifact with the deployment loader and registry. It
runs each example through the same step executor with a fake HTTP provider.
A successful check prints the artifact's exact-byte SHA-256, package identity,
version, origin, and number of examples. A failed check exits nonzero and
identifies the affected manifest or fixture field.

In `conformance.json`, use an array of examples. Each names an `operation`,
its `input`, the expected `request`, a fixture `response`, and the expected
step `output`. The request includes its method, the path and query as one
string, all generated headers with lowercase names, and a JSON body when
present. The response supplies an HTTP status and an optional JSON body. The
runner uses `fixture-<fieldName>` for each credential field. Keep all values
synthetic. A fixture may compare what the executor sent to the approved
origin, but the harness returns the fixture response entirely within the CLI
process.

## Test the rendered workflow

Set the release origin to a dedicated HTTPS test endpoint. Use a staging
account and a disposable credential. The scaffold's example origin is for
the offline check.

1. Check the final bytes, then install that exact artifact in a separate
   local Compose project with its own data volumes and published ports.
   Configure the approval with the identity, release, SHA-256, and origin
   from the check output. Start the API and worker with the same approved
   artifact. Follow the [community release deployment instructions](../operations/single-server.md#community-integration-releases).
2. Create a workflow and find the integration's tile in the step picker.
   Verify that the picker shows the publisher, destination, and expected action.
3. Open the step's setup and use **New … connection**. Verify the credential
   field labels and masking, then save and test the connection. Confirm that
   the provider accepts a valid credential and rejects an invalid one.
4. Select the tested connection, map representative inputs, publish, and run the
   workflow. Check the result against the provider response and confirm that
   the provider received the intended path, query, headers, and payload.

The [F57 product proof](https://github.com/vigani1/pertexo/pull/835) covers the
tile, credential form, connection tests, and published output with a controlled
provider.

## Publish and review

Attach `integration.json` and its SHA-256 as release assets for the exact
version in the manifest. For a checksum file suitable for `sha256sum -c`, run
`sha256sum integration.json > integration.json.sha256` from the author folder.
Make the README and fixture available alongside the source. Recheck the
downloaded file before adding its checksum to an approval.

List every endpoint, the connection test, what the credential grants, where
the executor puts it, and what workflow inputs go into paths, queries, and
bodies. Describe each operation's side effects and the output fields it
returns. Operators should compare that disclosure with the manifest before
approving it and keep the reviewed bytes and checksum together.

Use the [operator instructions](../operations/single-server.md#community-integration-releases)
to install a release, keep old revisions for workflows that still pin them,
and remove or restore an approval.
