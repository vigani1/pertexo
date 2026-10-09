# ADR 059: Version-fenced connection health observations

- **Status:** accepted for the F30 first slice
- **Date:** 2026-10-01
- **Amended:** 2026-10-09 under ADR 069

> **Amendment note (2026-10-09, ADR 069).** Every feature switch is on: run
> health always applies, so the off/observe/enforce mode under *Rollout and
> trade-offs* is gone, and an observation no longer records the mode it was
> produced under (migration 0021).

Run-derived connection health is evidence about a particular credential, not
another interpretation of a node's failure. We will persist a small observation
with an accepted node-attempt completion and apply it independently through the
existing durable outbox/receipt mechanism. This preserves the provider outcome
and prevents delayed evidence from damaging a rotated or recovered connection.

## Signals and scope

The first automatic provider is `slack.send_message@1` with `slack_bot_token`.
Only a parsed Slack response with `ok: false` and `account_inactive`,
`token_expired`, or `token_revoked` is definitive credential rejection. Map
these to a closed set of Pertexo reason codes; never persist provider text.
A validated successful send is positive evidence. No observation comes from
local validation, credential resolution, a failed dispatch fence, generic
`authentication` failures, HTTP 401/403 alone, `invalid_auth`, `not_authed`,
missing scope, channel/permission errors, rate limits, transport failures,
timeouts, malformed responses, or ambiguous outcomes.

This deliberately favors missed detection over disabling a usable connection.
Slack documents that `invalid_auth` can describe an IP restriction, while the
three allowed rejection codes describe expired/revoked credentials or a deleted
account/workspace. The same narrow classification applies to Slack manual tests;
other providers retain their existing manual-test behavior. Automatic health for
generic HTTP, Resend, notifications, and previews is out of this slice.

Sources checked 2026-10-01: [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/)
and [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).
These signals do not change ADR 023's dispatch, ambiguity, or retry decisions.

## Durable evidence and authority

Persist the connection ID, provider/auth identity, immutable secret-version ID,
and current health revision when the existing node-attempt dispatch fence is
accepted. Resolve this identity against the attempt's published connection
binding in the database; the worker cannot choose an unrelated connection.
Repeated dispatch marking cannot replace the recorded identity. The revision
comes from the database, not a caller's timestamp.

The trusted provider adapter produces only a closed observation kind and safe
reason through the execution runtime. It cannot select the observation's target.
Completion validates this evidence against persisted dispatch identity and the
accepted attempt lease, then atomically persists at most one observation and its
outbox command with the existing attempt outcome and completion receipt. A
duplicate completion must compare the observation as well as the outcome; a
different duplicate is corruption, not a second observation. An attempt without
durable dispatch evidence cannot produce health evidence.

A dedicated bounded health command consumes persisted observation IDs through
the existing worker outbox/receipt infrastructure. Its transaction validates the
workspace, provider, attempt source, current secret version, and health revision,
locks the connection, applies the transition, and receipts the observation
atomically. It accepts no arbitrary target, status, or reason in a queue payload.
Retrying this command never executes the provider or changes the attempt/run.
There is no standalone worker health setter, extra scheduler, or in-memory
fire-and-forget write. Do not wire the current `recordConnectionHealth` method
into worker execution; remove/restrict its obsolete worker surface as part of
the new capability. Preserve unrelated supported callers if any are discovered.

The dispatch marker, accepted completion, and evidence production remain one
execution protocol: database failure follows existing durable-completion
reconciliation and never authorizes an unsafe provider replay. A failure applying
health after completion can delay health only, not run progress. Use the existing
outbox redelivery/recovery and observability contracts, including poison-job
handling. No unbounded scan of attempts is a substitute for durable delivery.

## Ordering and recovery

Add a monotonically increasing health revision to each connection. It advances
when health enters `reauthorization_required`, on a successful current manual
test (even if already active), and on rotation or revocation. Capture it at
dispatch for both runs and manual tests. Under the connection lock, an observation
can change health only when its secret version and revision are still current
and the connection is not revoked. Do not use completion timestamps to resolve
concurrency.

- The first applicable definitive rejection sets `reauthorization_required`,
  advances the revision, records the safe reason and transition time, and emits
  one health-transition event. Concurrent duplicate failures cannot emit more
  copies of that transition.
- Applicable run success updates current-credential positive health evidence and
  clears an applicable diagnostic, but does not advance the revision merely for
  another success while active. Thus a harmless success cannot suppress a real
  rejection from the same revision.
- A run dispatched before a negative transition cannot clear it afterwards.
  Normal execution continues to reject reauthorization-required connections at
  the existing dispatch fence. Recovery is an explicit successful test started
  after that transition, or credential rotation; do not send a workflow side
  effect solely to probe recovery.
- Allow authorized manual tests of active and reauthorization-required
  connections through claim, secret resolution, and dispatch. Keep revoked
  connections untestable. A test started before a newer transition cannot clear
  that transition; its test result may be recorded without changing health.
- Rotation activates the new credential, clears current-credential health/error
  evidence to unknown, and advances the revision. It is not proof of health.
  Revocation is absorbing. Late old-version tests and runs alter neither state.

Keep `lastTestedAt` exclusively about explicit tests. `lastHealthyAt` describes
positive evidence for the current credential, whether a test or a run. Provide
separate last run-observation and health-transition times/source as needed by
the response; never label a run observation as a test. Nondefinitive test failures
can remain visible as test diagnostics, but cannot overwrite the authoritative
reason for an outstanding credential rejection. Events distinguish tests from
health transitions and contain bounded safe metadata only. F27 may consume
transition events later; this slice sends no notices and changes no auto-pause
policy.

## Used-by meaning and permissions

Used-by means retained immutable published workflow versions whose integration
usage references this connection, not drafts and not just the current version.
Return one row per workflow/version with deduplicated operations and explicit
current-publication and archived-workflow labels. Reuse
`workflow_integration_usage`; do not scan graph JSON or create another source of
truth. Historical versions remain relevant to pinned runs and explicit replay.

The read requires both connection-read and workflow-read authority in an active
workspace, with workspace-scoped queries and ordinary non-disclosure behavior.
It exposes only workflow/version metadata already readable by that principal,
never graph contents or secret-version identity. Use bounded keyset pagination.

## Rollout and trade-offs

Use an explicit run-health mode: `off`, `observe`, or `enforce`, default `off`.
Observe exercises durable classification/delivery without changing connection
state. Observations must record their production mode; only evidence produced
under enforce and consumed while enforce is enabled can change health. Other
evidence is receipted without mutation and is never replayed retroactively when
enforce is enabled. Disabling stops future automatic transitions; it does not
silently reset existing reauthorization-required connections. Manual recovery
remains available. No production activation is authorized by this decision.

This adds a small durable command and eventual health visibility, rather than
coupling mutable connection locks to node completion. The costs are explicit
delivery, readiness, retention, and compatibility work. Synchronous standalone
health writes were rejected because a crash loses evidence and mutable health
failures can otherwise interfere with execution. Inferring from safe error codes
was rejected because those codes mix provider evidence with local failures.
