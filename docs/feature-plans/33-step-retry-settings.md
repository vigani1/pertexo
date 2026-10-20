# F33 — Step retry settings

Status: approved by the owner 2026-10-20; implementation in progress.
Parent: [product roadmap](../product-roadmap.md). Size: **M**.

## Outcome and precedent

An editor can choose how many times an action is tried and the wait between
tries, without changing whether repeating it is safe. Existing workflows keep
their exact retry behavior until an editor chooses an override and publishes it.

[n8n](https://docs.n8n.io/integrations/builtin/handle-rate-limits.md) exposes
Retry On Fail and a wait between tries on the step.
[Make](https://help.make.com/retry-error-handler) lets a failed module use a
bounded attempt count and interval.
[Zapier](https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay)
retries failed steps and delays final error notification until attempts finish.
Use n8n's simple count-and-wait controls; keep Pertexo's existing safety and
durable scheduler rather than copying another product's replay semantics.

## Decisions and rules

1. Add optional `retry: { maximumAttempts, delayMillis }` to the existing
   workflow node and compiled executable. No new document format/version,
   database table, role, service, dependency or queue is needed. Omit the field
   when using the platform default, including from compiled projections, so old
   executable checksums and stored pins still work.
2. **Default** is today's policy: up to three total attempts, bounded
   exponential backoff starting at one second, deterministic jitter, and the
   existing provider delay floor. No behavior or checksum changes when unset.
3. **Custom** uses one to five total attempts (the first try counts), with a
   fixed wait of 1–60 seconds, in whole seconds. Starting values are three tries
   and one second. **Do not retry** means one total attempt. No expressions or
   per-error overrides. These bounds fit the existing scheduler's delay cap and
   avoid an unbounded retry storm; five tries follows n8n's small retry model.
4. Only the attempt limit and timing change. The existing retry decision still
   owns error eligibility, dispatch evidence, side-effect classes and stable
   provider keys. A permanent error, cancellation, deadline, or
   `outcome_unknown` never becomes automatically retryable. A provider's bounded
   minimum delay can lengthen the custom wait. Custom waits have no jitter, so
   the chosen wait is never shortened. Default backoff/jitter remains exact.
5. Settings apply to worker-executed actions, including actions inside loops,
   parallel branches and failure handlers. Trigger admission and engine-owned
   control/human-task outcomes are not retried by this feature: no settings on
   triggers, Condition/Switch, Parallel/Merge, For each, Wait, Call, Stop run,
   Approval or Request input. A single shared workflow-model predicate owns
   applicability for validation and the editor; unsupported overrides fail
   publication rather than silently pretending to work.
6. Publication pins the override. Restoring, promoting, duplicating and portable
   export/import preserve it. Existing runs, replay and recovery use their exact
   published version; recovery's historical attempt checks use that step's
   configured limit. Changing retry settings makes an existing pinned sample
   stale; old samples remain valid when the setting is absent.
7. Retries use the existing PostgreSQL due time and coordinator, release the
   attempt slot while waiting, survive restarts and preserve attempt history.
   Failure links, error workflows and failure notices retain today's behavior
   after exhaustion. Run deadlines and cancellation still stop waiting work.
8. **Test workflow** uses the captured draft's settings; pins still bypass calls.
   Single-step **Test step** remains one attempt: its existing preview lease is
   not a second coordinator. Explain that distinction in the controls/guide.
9. Put a collapsed **Retries** disclosure in action Setup, with Default,
   Do not retry and Custom choices. Show Max tries and Wait between tries
   (seconds) only for Custom. Use existing fields, scratch handling, shared
   Disclosure and serialized undo/save behavior; invalid unfinished values remain
   visible, block saving/publishing, and cannot be hidden by changing modes.
   Read-only viewers can inspect the setting. Keep Weft and reduced motion.

## Structure

- `packages/workflow-model/src/step-retries/contract.ts`: one bounded portable
  schema, defaults and applicability rule; graph schema and pin identity use it.
- `packages/workflow-engine/src/compilation/`: copy the optional typed field
  through compilation and loading; omit it for legacy nodes.
- `packages/workflow-engine/src/attempt/retries.ts`: the existing decision
  accepts typed step settings, changing only count and delay. Coordinator and
  recovery pass the pinned node's settings to that same owner.
- `packages/contracts/artifacts/`: regenerate existing OpenAPI artifacts from
  the shared graph schema; no endpoint-specific second declaration.
- `apps/web/src/features/workflow-editor/components/inspector/retries/`:
  focused setup controls using the existing NodeFormApi; graph updates retain
  and clear the optional setting without losing other edits.
- `docs/guides/step-retries.md`, ADR 007 amendment, and the roadmap: explain
  total tries, default versus fixed waits, safe refusal, deadlines, failure
  routes, preview behavior and pagination restarting from page one.

## Delivery and verification

One vertical PR, with a plan commit followed by coherent implementation/test
commits. No moves are required. If main conflicts, replay onto a fresh branch;
never resolve conflicts in a merge commit. Full pre-push hook, then green CI and
rebase merge.

- [ ] Shared schema: bounds/unknown fields, unsupported definitions, nested
      bodies, portability, checksums and unchanged legacy sample identity.
- [ ] Engine: one/five-try exhaustion, exact custom waits, provider delay floor,
      unchanged default jitter/backoff, permanent/unsafe/unknown failures,
      recovery evidence, nested actions, cancellation and deadlines.
- [ ] Real worker/PostgreSQL qualification: configured tries and persisted retry
      waits/resumption, including one-try refusal and exhaustion before routing.
- [ ] Editor: desktop/phone, read-only, undo/save/reload, invalid scratch and
      default restoration; full mocked browser suite and rendered inspection.
- [ ] Build, lint, types, unit tests, generated contracts, architecture checks,
      React Doctor, full pre-push and CI.
- [ ] Guide, ADR 007 and roadmap marked delivered after qualification.

Later: error-specific policy, configurable backoff/jitter, longer delays,
single-step preview retry coordination, new integrations and AI.
