# F61 — AI Agent step

Status: designed. Follows [F60](60-mcp.md) and precedes
[F62](62-ai-authoring-assistant.md). Execution contract in
[ADR 098](../adr/098-agent-tool-execution.md).

## Outcome and usage

Add **Agent**, choose a workspace AI connection and tool-capable model, and
map its task and input. Choose a bounded set of tools from eligible existing
step manifests and authorized published callable workflows. Give each tool
a unique alias, description and fixed setup, including any connection,
target and fixed arguments. The remaining bounded input fields are what
the model can propose. For example, an agent can look up an order through
a read tool, then propose a refund through an approved callable workflow.

For write tools, choose an approval audience through the existing
approval flow or explicitly allow that particular tool to run without
approval. Publication review shows that allowance with the pinned tool
configuration. The run inspector shows each model turn and tool call,
including mapped input where authorized, approval, retries, outcome,
elapsed time and reported model usage. Show child runs through existing
Call lineage. The author receives a bounded final `{ text }` result.

Operators configure permitted provider endpoints, model and price ceilings,
connections, approver access and run capacity. Disclose that mapped input,
tool schemas and bounded results enter the model request. Existing run-data
permissions and retention govern the inspector.

## Settings and execution

- Default to one outstanding tool call per turn. Cap tools, request and
  result bytes, turns, aggregate tool calls and physical model dispatches.
  Require worker/run deadlines and a finite per-invocation deadline that
  continues while waiting for approval or Call. Timeout follows existing
  wait/child cancellation rules. Check remaining limits before each
  dispatch, including retries and repair. Exhaustion is a typed terminal
  failure with prior effects still visible.
- Enforce aggregate input/output token ceilings and an estimated model cost
  ceiling. Require operator-configured conservative per-model rates for
  both token directions, including explicit zero for an unmetered local
  model. Snapshot the selected rates at admission. Before dispatch,
  reserve from the run-local budget using a conservative input bound and the
  maximum requested output tokens. Refuse unsupported accounting or
  insufficient headroom. Settle against supported provider-reported usage
  where available. Keep the reservation charged for unknown outcomes, and
  stop further dispatch if accounting exceeds the reservation. The estimate
  covers model requests. Remote tool charges and actual provider billing
  follow the operator's provider arrangements.
- Compile tool descriptions and inputs from the eligible versioned
  manifests or the pinned callable contract. Validate each proposed call
  through the normal input boundary. Restrict eligible manifests to bounded
  JSON ordinary actions with reviewed effect and result disclosure policy.
  Treat unclassified remote tools and callable workflows as write-capable.
  A retry class alone cannot establish read-only behavior. Exclude
  arbitrary HTTP or code execution, nested agents, control steps and
  interfaces without a bounded tool projection. Include connections and
  Call targets in existing publication/resource checks and recheck access at
  dispatch. Model output and tool results cannot change grants or setup.
- Keep durable turn history inside one invocation for resume. Cross-run
  chat and memory can be added later behind explicit workflow inputs and
  data stores, and the initial workflow tasks have no year-one memory
  dependency. Defer cross-run memory, identity and retention machinery.

## Codebase structure

Extend the AI module under `packages/integrations/src/ai/agent/` for the
versioned step and use the shared `ModelClient` and provider adapters for
normalized tool proposals. Keep tool setup and invocation types in
`workflow-model` and `node-sdk` with their existing owners. The continuation
and budget rules live in `packages/workflow-engine/src/` beside control
execution and checkpoints. Existing `core/runs` and `core/attempts` persist
transition, task and attempt facts with normal outbox and receipt mechanics.
The worker composes the same executor registry and capability dispatch
used by graph steps. The workflow editor and run inspector consume the
existing catalog and run APIs with additive projections. No new package,
entry point, queue, role or worker type.

## Implementation slices

1. **Read tools and inspection.** Ship bounded model turns, one eligible
   read action, real attempt history and restart qualification. Use a local
   fake provider and action. No owner account.
2. **Manifest write tools.** Add approvals and explicit per-tool allowances,
   with publication review, inspector and uncertain-outcome tests. Use an
   isolated database and fake effect sink. No owner account.
3. **Callable workflow tools.** Add pinned Call targets with typed results
   and ordinary child wait/cancel semantics. Test using local workflows
   and the fake model. No owner account.

## Tests that prove it

Through the real worker and database, exercise a malicious tool proposal,
bad arguments, expired and double-submitted approval, connection revocation
and another workspace's tool target. Prove each limit before further
dispatch, including across an unknown provider outcome and worker loss.
Restart after accepting a tool proposal, while waiting for approval, after
dispatch of a write with no receipt, and after the tool completion receipt.
Inspect the resulting attempt and child history. Verify one approved
effect, no implicit repeat after uncertain effect, and ordinary production
run replay explicitly starting fresh.
