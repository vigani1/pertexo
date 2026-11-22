# ADR 097 — MCP exposes explicitly published workflow versions

- **Status:** accepted
- **Date:** 2026-11-21
- **Feature:** [F60](../feature-plans/60-mcp.md)

## Context

An external AI client needs a discoverable callable contract and a result
that can outlive its HTTP request. Tool discovery itself reveals workflow
metadata. A general workspace token or an automatically following version
would make it easy to delegate more than the publisher reviewed.

## Decision

Expose one workspace HTTP endpoint for clients configured to send a Pertexo
workspace API token over HTTPS. Use the existing token issuance, digest,
expiry and revocation runtime. Add a dedicated delegated `mcp:invoke`
capability limited to MCP discovery, invocation and its own status. Recheck
the token's workspace and current actor/workflow authority on every request.
Listing requires workflow visibility and run authority at the role level.
Invocation additionally requires the active exposure and the matching
published version under the run admission transaction. A token having only
this scope receives no ordinary REST run or workflow grants. Apply existing
folder and resource grants and active workspace status throughout.

An authorized workspace administrator with workflow publication rights can
expose a typed entry on the current published version. The bit of exposure
state belongs to that workflow and records the selected version, entry and
tool metadata. A later publish invalidates exposure until an administrator
reviews and exposes the new contract. Pause, archive or revocation stops new
calls. Revoke exposure or the token to stop status reads too. Accepted runs
use ordinary run lifecycle and cancellation. The status lookup binds the
invocation to its initiating token ID, workspace, workflow and exposure revision. Re-exposure issues a fresh revision.
Scope lookup to the run's invocation binding and project only the declared
result. The binding records the initiating token, exposure revision and opaque
reference digest. The run row supplies its workspace and workflow. The binding
and result expire with normal run detail retention. Command receipts retain the
product-wide 24-hour replay window. A repeated call after its receipt expires
may create a new run.

Record exposure changes and run admission through existing workspace audit
facts. Correlate tool name, exposed version, actor/token ID, run and outcome
through safe operational facts or the existing run history. Keep raw inputs,
outputs and bearer values out of the audit fields. Rate limit list, call and
status independently through the existing admission seam.

## Alternatives and consequences

- Requiring the MCP OAuth profile now expands identity and discovery work.
  Explicitly configured bearer authentication serves initial managed
  clients. Clients requiring advertised OAuth discovery need a later
  authorization design. Pertexo makes no OAuth-profile compatibility claim.
  [MCP authorization profile](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- Giving the MCP token general run scopes exposes unrelated API surfaces.
  Discovering every published workflow or following latest publication
  implicitly would disclose or execute an unreviewed contract.
- An HTTP-response-only result leaves long or approval-gated work without
  retrieval. A second scheduler or MCP-specific queue would duplicate run
  admission, retention and recovery. The status tool preserves those
  guarantees using the accepted run.
