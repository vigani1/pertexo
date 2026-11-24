# F60 — MCP server and client step

Delivered in [#851](https://github.com/vigani1/pertexo/pull/851),
[#853](https://github.com/vigani1/pertexo/pull/853) and
[#854](https://github.com/vigani1/pertexo/pull/854). Server contract:
[ADR 097](../adr/097-mcp-workflow-exposure.md).

## Outcome and usage

To expose a workflow, define typed callable inputs and a result on its Manual
or JSON Webhook entry, publish it, and explicitly expose that version under a
tool name and description. A workspace administrator issues a scoped API
token and configures the external client with the workspace endpoint and
bearer header. Clients discover the published contract, invoke the selected
tool and check its result. Operators configure HTTPS, admission limits and
audit retention.

To call a remote tool from a workflow, create an MCP connection with its
Streamable HTTP endpoint and bearer secret, test it, and select a listed tool
in **MCP Call Tool**. Review its input contract, map arguments and use its
bounded JSON result downstream. Operators configure approved network
destinations and rotate the credential. Remote results and tool descriptions
are untrusted data.

## Server settings and execution

- Serve a workspace-scoped Streamable HTTP endpoint pinned to protocol
  revision 2025-11-25 in v1. Handle initialization, initialized notification,
  ping, listing and calling tools using JSON responses and notification
  acceptance. Use stateless HTTP, validate supplied Origin and negotiated
  version headers, and return 405 for standalone GET streams. Document the
  explicit-header compatibility requirement.
  [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- Accept one run through ordinary admission for the exposed version. Project
  the callable entry input to an object JSON Schema and the callable result
  into the tool result envelope. Validate inputs with the existing callable
  validator, and publish only the declared, validated result. Never forward
  webhook headers, raw run values or attempt traces. Reject entries that
  need files, non-object inputs or an externally delivered trigger event.
- Return `completed`, `pending` or a safe terminal failure from the same
  authorized result reader. Ship immediate pending first. A subsequent
  bounded wait may return a completed result on the same call. Disconnect
  and timeout end the wait while the accepted run continues. In both modes
  a reserved status tool accepts an opaque invocation reference, checks
  the same token and current authorization, and returns the same envelope.
  A run failure is a tool error. Use normal run retention, including expiry
  of the reference. This surface uses ordinary MCP tools and needs no Tasks
  extension. [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- A JSON-RPC ID correlates a reply. Use the existing command fingerprint
  and receipt with an explicit caller-supplied idempotency key in a
  documented Pertexo JSON-RPC `params._meta` field where present.
  Scope it by caller, workspace and tool and compare the resolved version
  and input fingerprint. A retry with the same key returns the original
  acceptance. Document that calling again without a key can create a run.
  Apply bounded lists, body and result limits, admission throttling by token
  and workspace plus the existing run capacity checks. Require MCP-compatible tool names unique
  within a workspace, reserving the built-in status name.

## Client settings and execution

- Register provider `mcp`, its bearer connection and `mcp.call_tool@1` once
  under ADR 095. Use the connection runtime and injected secure HTTP for
  initialization, capability discovery, listing and calling. The endpoint is
  connection-owned, preserves its configured path and uses the HTTP Request
  address policy on every exchange. Deny redirects and apply current secret
  verification on each dispatch. Hold any negotiated session ID within the
  operation and bound paging, SSE parsing, bytes and elapsed time. Support
  JSON and bounded SSE replies on POST. Defer local stdio, OAuth discovery,
  standalone event streams, callbacks and the Tasks extension.
- Retain the selected tool name and normalized schema with the versioned
  step. Admit a bounded object subset with local validation. Reject
  unsupported schema features and schema drift requiring editor review.
  Where a result schema is available and supported, validate structured
  content. Support bounded text content as a distinct result shape. Refuse
  file and resource content in v1. Surface protocol errors and `isError`
  as safe step failures and withhold raw remote error bodies.
- A remote tool may have effects regardless of MCP annotations. Use the
  ordinary unsafe retry class and dispatch fence at the tool call. Discovery
  requests also check current credentials. An uncertain call outcome stops
  for inspection and follows the normal uncertain-effect policy. Tool
  discovery and a connection test never invoke an advertised tool.

## Codebase structure

Use `apps/api/src/mcp/` for protocol, auth composition and bounded waiting.
Keep exposure management with `core/src/authoring/settings/` and runtime
admission and result authorization with `core/src/runs/`, using its existing
entry point. Own transport-neutral exposure schemas and declared routes in
`packages/contracts`. Keep any added durable fields with their owning
workflow or run tables. Use `apps/web/src/features/workflow-settings/` for
exposure and the existing API token and run UI. The client lives under
`packages/integrations/src/mcp/`, with one registration in
`packages/integrations/src/modules.ts`. The workflow editor uses
the projected connection and step forms. No new package or entry point.

## Implementation slices

1. **Expose a published tool.** Ship management, token-scoped discovery,
   queued invocation and status with an in-repo MCP client. No owner account.
2. **Call an external tool.** Ship the MCP connection and step with a local
   fake MCP server using the real address policy and worker. No owner account.
3. **Return fast results inline.** Add the bounded wait to the existing
   invocation. Prove identical authorization and result projection for fast
   completion, slow status polling and disconnect. No owner account.

## Tests that prove it

Exercise real API, database and worker with two workspaces and two tokens.
Test discovery and invocation across a folder grant change, token revoke,
unexpose, republish, schema mismatch and result expiry. Verify rate and
capacity refusals, receipt replay, concurrent duplicate calls, status
isolation and audit correlation. Test the client with redirect and denied
address, malformed and oversized replies, unsupported schemas, a changed
connection and worker loss after the fake server accepts a call. Verify a
valid mapped result in the run inspector with credentials absent.

## MCP server client settings

Set the server URL to `/v1/workspaces/{workspaceId}/mcp` on the Pertexo HTTPS
origin and send `Authorization: Bearer <workspace API token>` with
`mcp:invoke` on every POST. Send `MCP-Protocol-Version: 2025-11-25` after
initialization. Clients that supply an Origin must use the configured Pertexo
web origin. The server responds with JSON and accepts the initialized
notification without a body. Standalone GET streams are unavailable.

Set `params._meta["pertexo/idempotencyKey"]` on `tools/call` to replay the
same accepted invocation within the normal command receipt window. A repeated
call without a key or after receipt expiry can create another run. Pass the
returned `invocation` to `pertexo.invocation_status` using the initiating
token. Revoking or changing an exposure invalidates its status references.

By default, a tool call waits briefly for an inline result before returning
the pending invocation. Set `params._meta["pertexo/waitMillis"]` to a
nonnegative integer to shorten the wait. A value of zero returns the
invocation immediately. The wait hint does not affect idempotency.
