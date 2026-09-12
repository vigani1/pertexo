# Worker telemetry review

Date: 2026-09-12. Primary reviewer read all 12 inventory files below in full.
Five unit files / nine tests passed. Current compiled-module probes used only
injected local meters, tracers and work functions; no provider was contacted.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/src/execution/coordinator-telemetry.ts` | KEEP; TEST WQ-101 | Finite duration guard and explicit clock-skew label are clear. The coordinator handler contains recording errors after durable commit, so this adapter throwing is not itself a durable-truth defect. |
| `apps/worker/src/execution/email-provider-telemetry.ts` | KEEP specialization; FIX WQ-100 | Fixed provider/operation identity and typed failure mapping earn this small wrapper; shared implementation must contain classifier failure. |
| `apps/worker/src/execution/http-provider-telemetry.ts` | FIX WQ-100/WQ-064; TEST WQ-101 | Useful HTTP-specific response-storage/error classifications; trace fallback can invoke work twice, production span-end is uncontained, and failure inspection can replace original rejection. |
| `apps/worker/src/execution/preview-telemetry.ts` | KEEP; TEST WQ-101 | Sink containment correctly protects committed preview truth. Explicit optional spreads preserve absent versus false values; no need for a generic attribute-builder DSL. Provider/operation labels rely on registry-derived caller values, not arbitrary request labels. |
| `apps/worker/src/execution/provider-telemetry.ts` | FIX WQ-100; KEEP shared mapping | Meaningful shared implementation for email/Slack. Metrics/setAttribute/setStatus are caught, but startActiveSpan, classifier and end are not. The comment promising diagnostics cannot change truth is broader than actual protection. |
| `apps/worker/src/execution/slack-provider-telemetry.ts` | KEEP specialization; FIX WQ-100 | Fixed identity and Slack failure mapping match executor interface. Do not merge distinct provider error types merely to remove two similar wrappers. |
| `apps/worker/src/triggers/trigger-telemetry.ts` | KEEP; TEST WQ-101 | Small fixed-label measurement adapter; runtime wraps record operations in recordTelemetry. Deferred-versus-healthy ternary expresses a genuine two-way domain classification. Construction failure belongs to runtime startup ownership review. |
| `apps/worker/test/coordinator-telemetry.test.ts` | KEEP; TEST WQ-101 | Asserts exact normal/skew labels and ignored NaN; add infinities, zero, and caller-level metric failure after commit. |
| `apps/worker/test/email-provider-telemetry.test.ts` | TEST WQ-101 | Checks returned object/error identity; shared counter spy cannot distinguish request and rate-limit instruments. Forbidden strings were never supplied, weakening privacy evidence. |
| `apps/worker/test/http-provider-telemetry.test.ts` | KEEP; TEST WQ-100/WQ-101 | Good exact labels, duration and named instruments. Diagnostic failure test only throws before callback; does not cover callback-then-throw, asynchronous trace rejection, end or classifier failures. |
| `apps/worker/test/preview-telemetry.test.ts` | KEEP; TEST WQ-101 | Named-counter harness and throwing-sink assertions prove containment; add omitted/false fields and reconciliation variants. Current sample alone does not prove the origin of provider/operation labels. |
| `apps/worker/test/slack-provider-telemetry.test.ts` | KEEP; TEST WQ-100/WQ-101 | Named instruments, typed rate-limit identity and exact labels are useful. Test claiming diagnostics never change truth only faults attribute/status methods, not span end/start or classification. |

## WQ-100 — contain the entire provider diagnostics lifecycle

Priority P1 for outcome preservation; FIX plus regression tests. Locations:
`provider-telemetry.ts:49–92` and `http-provider-telemetry.ts:38–68,92–109,160–190`;
email/Slack classifier wrappers at `:19–25`. Executor registration callers in
`packages/integrations/src/http-request/executor.ts:493–496`,
`packages/integrations/src/email/executor.ts:286` and
`packages/integrations/src/slack/executor.ts:283` return the measured promise.

Current problematic shapes:

```ts
return tracer.startActiveSpan(name, async (span) => {
  try { return await work(); }
  catch (error) { classifyFailure(error); throw error; }
  finally { /* guarded recording */ span.end(); }
});
// HTTP local adapter:
try { return options.trace(measured); }
catch { return measured(); }
```

Probes: shared and HTTP production adapters each executed work once, then
rejected with the injected span-end error instead of returning the successful
object. HTTP local trace invoked work, threw synchronously, and fallback
executed work again (count=2). A hostile rejected value whose getPrototypeOf
throws was replaced by classification failure. These demonstrate adapter
contract failures, not a claim that the configured OpenTelemetry SDK commonly
throws or that a live provider was duplicated.

Apply WQ-064's single-execution semantics to the HTTP trace path; do not create
a second tracing framework. Track the actual work promise separately from the
optional trace promise, contain synchronous/asynchronous trace failures, and
never infer that a throwing trace means its callback has not started. Preserve
the original work value/rejection by identity. Classification is best-effort
diagnostics: catch its failures separately, use bounded fallback labels, and
rethrow the original unknown without coercion. Span end is best-effort too.
Keep provider dispatch/uncertainty and typed retry truth unchanged; never
convert a telemetry exception into a new provider execution failure.

Acceptance matrix for shared provider and HTTP production/local interfaces:
success and typed error × start failure before callback, callback then sync
throw, callback then rejected trace, setAttribute/status/add/record/end failure;
include hostile classifier rejection. Assert exactly one work invocation,
original return/rejection identity, no unhandled rejection, no secret/error
message attributes, and correct ordinary metrics. Constructor failure must
either fall back safely under the established diagnostics policy or be rolled
back by the startup owner; do not silently acquire resources and abandon them.
Reuse runtime acquisition work from WQ-057/WQ-096 where applicable.

## WQ-101 — strengthen telemetry evidence without flattening useful policy

Priority P2 TEST; P3 localized clarity. Use one small named-instrument test
harness where it reduces repeated unsafe casts, keeping each provider's exact
expected attributes in its own tests. Do not expose test-only production ports.

- Email: separate request/rate-limit counter spies, assert rate-limit once and
  never on success. Include actual output/error metadata sentinels and exact
  allowed attributes; tests containing absent input strings are not sufficient
  privacy evidence. Content not accepted by the telemetry interface should be
  tested at executor/runtime integration, not invented as telemetry input.
- HTTP: all supported outcome classifications, artifact/inline, clock throws,
  non-finite clocks, optional annotation failure, rate-limit failure, and WQ-100.
- Slack/email: unknown ordinary rejection identity and classified dispatched
  flags, all WQ-100 diagnostic failure stages.
- Preview: optional false preserved, absent fields absent, each reconciliation
  decision. Caller-level evidence must show provider/operation come from the
  trusted node definition. Do not call the string type alone a cardinality bug.
- Coordinator/trigger: retain caller containment after committed work; the
  coordinator handler test already injects a throwing schedule metric and
  asserts the committed result. Extend that evidence to trigger scanner state.
  Add a focused trigger adapter test for exact accepted/deferred/skipped/lag
  instruments and healthy/throttled/degraded labels. Constructor rollback is
  a runtime-owner test, not a reason to catch every construction error blindly.

Order: single-work trace containment and original outcome preservation first;
then targeted evidence and optional shared test harness. Keep explicit finite
classification branches; fewer conditions is not an acceptance criterion.
