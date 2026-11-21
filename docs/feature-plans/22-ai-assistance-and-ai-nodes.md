# F22 — AI authoring assistance, model nodes and controlled tools

Status: proposed plan; not implementation-authorized by this document.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: Later optional capability. Relative size: **XL**, not a calendar estimate.

## Outcome

AI can help draft valid workflows or perform explicit bounded model tasks without bypassing review or leaking workspace data.

## Current implementation and dependencies

[F56](56-ai-model-step.md) delivers text generation and structured extraction
using typed workspace AI connections. PR [#841](https://github.com/vigani1/pertexo/pull/841)
contains the initial AI module and shared provider transport. F56 slices 3–4
are in progress separately. Implementation evidence belongs to the individual
plans. This document records the order and shared constraints.

## Codebase structure

[ADR 091](../adr/091-core-layer.md) governs authority and persistence. API and
worker composition inject secure transport from `secrets` into the provider
modules. [ADR 094](../adr/094-model-steps.md) governs model validation, dispatch
and usage. [ADR 095](../adr/095-integration-modules.md) keeps steps, connections
and protocol adapters together in their integration. Workflow-model owns
browser-safe graph contracts, the engine owns execution transitions, and
core owns execution admission and durable facts. Reuse the existing package
entry points. Each linked plan names its implementation folders and seams.

## Delivery order

Finish the AI track before starting new integrations. Each numbered plan
specifies independently shippable slices and local proving fixtures. None
requires the owner's real accounts.

1. [F56 slices 3–4 — Model usage, connection tests and editor](56-ai-model-step.md)
   complete the current implementation.
2. [F59 — Classify](59-ai-classify-step.md) adds validated category routing.
3. [F60 — MCP](60-mcp.md) exposes selected published versions and adds a
   connected client step.
4. [F61 — Agent](61-ai-agent-step.md) adds bounded normal step and Call
   execution as tools with approvals for writes.
5. [F62 — Authoring assistant](62-ai-authoring-assistant.md) explains failures
   and proposes validated, human-reviewed drafts.
6. [F63 — Guardrails and evaluations](63-ai-guardrails-and-evaluations.md)
   adds routing checks and table-backed cases with deterministic scoring.

## Acceptance evidence

Malformed generated graph rejected, hallucinated node denied, prompt injection cannot gain tool rights, budget exhaustion, secret exclusion, output schema failures and approval race.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

Autonomous production mutation, unbounded agents, hidden provider usage or sending real user payloads without policy.

## Rollout and rollback

Disable assistant/model admissions; ordinary manually authored workflows unaffected; in-flight tool effects keep their outcome records.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Primary-source research

Checked on 2026-11-21. These are comparisons of product interfaces.
The Pertexo plans derive their execution behavior from the repository.

- n8n distinguishes text and extraction nodes from a Text Classifier that
  takes category names and descriptions and can route to Other. Its Tools
  Agent attaches tools, a model and optional memory through sub-nodes.
  Its Guardrails step offers a Fail branch, and evaluations distinguish
  quick cases from scored runs. This supports separate controls for routing,
  tools and quality checks.
  [Basic LLM Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainllm/),
  [Information Extractor](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.information-extractor/),
  [Summarization](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainsummarization/),
  [Text Classifier](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.text-classifier/),
  [Tools Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/),
  [Guardrails](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.guardrails/),
  [evaluations guide](https://docs.n8n.io/advanced-ai/evaluations/overview/),
  [production evaluation playbook](https://blog.n8n.io/production-ai-playbook-evaluation-and-monitoring/).
- n8n's builder generates, refines and debugs workflows. Its public instance
  AI tool documentation describes catalog discovery, node schemas and
  validation, and documents renamed discovery tools. The reported LangGraph
  implementation and the exact `search_nodes`/`get_node_details` pair
  are unverified for the current hosted builder. Pertexo needs only the
  documented pattern of grounding edits in a catalog and validating them.
  [AI Workflow Builder](https://docs.n8n.io/advanced-ai/ai-workflow-builder/),
  [public tool documentation](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/instance-ai/docs/tools.md).
- Zapier announced the move from Agents to AI by Zapier with actions as
  tools and approval configurable per tool. Copilot builds or outlines
  Zaps from natural-language requests.
  [AI by Zapier announcement](https://zapier.com/blog/zapier-agents-is-now-ai-by-zapier/),
  [Copilot guide](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zaps).
- Make documents the AI Toolkit and Agent modules, scenario and MCP tools,
  sub-agents, a Make MCP server and Maia for creating and troubleshooting
  scenarios. [Make release notes](https://help.make.com/2026),
  [Make AI Agents](https://help.make.com/make-ai-agents-new).
- Activepieces documents agents that select piece actions and call flows,
  MCP and MCP Client pieces, and a platform MCP server exposing authoring
  and workspace operations. F60's interface is limited to invocation and
  status of explicitly exposed workflow versions.
  [Agents](https://www.activepieces.com/docs/agents),
  [MCP piece](https://www.activepieces.com/pieces/mcp),
  [MCP Client](https://www.activepieces.com/pieces/mcp-client/mcp),
  [platform MCP server](https://www.activepieces.com/docs/mcp/overview).

## Delivery tracker

- [ ] Baseline reconciled against current code and accepted decisions.
- [ ] Product choices resolved; necessary ADR accepted.
- [ ] Contracts and failure/security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence lives in the linked delivery plans and their implementation PRs.
