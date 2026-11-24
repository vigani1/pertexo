# F22 — AI authoring assistance, model nodes and controlled tools

Delivered on `main` in the slices below. Each plan records its scope, provider
requirements and verification evidence.

- [F56 — AI Model](56-ai-model-step.md) generates text or extracts structured
  data through configured model connections and records usage.
- [F59 — AI Classify](59-ai-classify-step.md) routes input to named categories.
- [F60 — MCP](60-mcp.md) exposes selected published workflows and calls tools
  on an external MCP server.
- [F61 — AI Agent](61-ai-agent-step.md) calls allowed steps and pinned workflows
  as tools, with explicit approval for writes.
- [F62 — Authoring assistant](62-ai-authoring-assistant.md) explains failed runs
  and proposes validated draft changes for review.
- [F63 — Guardrails and evaluations](63-ai-guardrails-and-evaluations.md) checks
  text and scores table-backed workflow cases.

The workspace controls which connections and tools are allowed. Model calls
have bounds and transfer disclosures. Applying an assistant proposal uses the
ordinary revision-checked draft save. The [model](../adr/094-model-steps.md),
[MCP](../adr/097-mcp-workflow-exposure.md) and
[agent](../adr/098-agent-tool-execution.md) decisions record the execution rules.
