# Workflow concurrency

Open a workflow’s **Settings → Concurrency**. **Runs at once** is the current
limit across all its published versions. Leave it blank to use only workspace
limits. Editors can change the limit and its overflow choice without publishing.

**Queue** is the default. Extra runs wait in acceptance order. An ordinary timed Wait or retry
keeps its place until it finishes, is canceled or times out. Quiescent human
approval/input waits release capacity and reacquire it before work continues. Start order does
not promise completion or external-effect order.

**Skip** ignores new automatic trigger events while this workflow is full.
Active runs, ordinary waits and already accepted queued runs occupy its places; reserved
starts are counted once. This also handles bursts that arrive before a worker
has started the first run. Changing the choice does not cancel existing backlog.
Without a workflow limit, Skip has no effect.

- Webhooks receive HTTP 202 with
  `{ "skipped": true, "reason": "concurrency_limit" }`. This also applies when
  a webhook normally waits for a workflow response. No run starts. For 24 hours,
  a retry with the same `Idempotency-Key` keeps the same skip result. Any other
  event, including identical bytes without a key, is considered independently.
- Schedules record **Skipped — concurrency limit reached** and move to the next
  occurrence. The schedule’s missed-run policy remains separate.
- Forms say **This workflow is busy. Try again shortly.** Entered values remain
  in the form; pressing Send response again makes a fresh attempt.
- Manual/API starts, replay and recovery return `workflow.already_running`
  (HTTP 409). They create no run and can be tried again when space is available.
- Calls from parent workflows and draft tests keep queuing. An error-workflow
  trigger records a concurrency refusal on its source run when its target uses
  Skip; that source failure remains visible.

The settings show the latest 20 skipped logical trigger events from the last
90 days. Native webhook delivery and schedule occurrence histories show their
reasons too. **Usage** counts skipped trigger events separately from runs in the
selected activity window. An exact replay does not count another logical skip.
Skips contain metadata only, never submitted data or credentials.

Lowering a limit does not interrupt active runs or revoke reserved starts.
Workspace queued/active limits still apply. For larger workloads, use
[For Each batching](for-each.md) within the existing execution bounds.
