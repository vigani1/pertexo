# ADR 081: Webhook replies are durable worker results with bounded API waits

- **Status:** accepted
- **Date:** 2026-10-16
- **Plan:** [F15](../feature-plans/15-synchronous-webhook-responses.md)

The owner authorized opt-in workflow replies, retaining immediate 202 as the
webhook default. Keep execution on workers. Verified ingress creates a
workspace-bound response record in the original run's admission transaction,
with its immutable publication's wait policy. Other run admissions never create
that correlation. The Respond to webhook step writes through an attempt-fenced
worker capability; first committed response wins, with stable retry receipts.
Replays, recovery, manual runs, Calls and previews cannot reply to the original
caller. A successful Respond step continues execution.

The API waits for committed PostgreSQL state with short indexed reads, releasing
connections between reads. Bound each request to 1–30 seconds (10 default) and
each instance to 32 concurrent waits; overflow and timeout return the durable
202 run receipt. This works across API instances and restarts without a second
transport or in-memory authority. Disconnect stops only waiting. The deadline aborts in-flight reads as well as timers; a response already
observed wins, otherwise the caller receives 202. A committed response wins over a later run failure;
otherwise a failure returns only a fixed safe error code.

JSON/text bodies have a 1 MiB ceiling within the existing engine envelope, and
headers have a closed safe list with generated content type, no-store and
nosniff. Response data follows run-detail visibility, 30-day retention and
workspace purge. No response body or headers enter audit, email, notices or
error-workflow summaries. This extends ADR 069's existing execution and storage
owners without another execution engine, service, role or numbered format.
