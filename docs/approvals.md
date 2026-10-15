# Approvals

Add an **Approval** step when a run needs a person’s decision before continuing.
Link its **Approved** and **Rejected** outputs to the paths that should follow.
The step produces a normal output:

```json
{
  "decision": "approved",
  "comment": "Reviewed the request",
  "decidedBy": "a member UUID",
  "decidedAt": "2026-10-15T10:00:00.000Z"
}
```

Map that output in later steps as usual. An omitted or empty comment becomes
`null`. Comments are plain text and visible to members who can read the run.

Owners and admins can decide by default. In Setup, choose roles, named workspace
members, or both. At least one must remain; up to 50 named members fit. Publication
checks that named members are active in the workspace. Membership and roles are
checked again when deciding, so removing a member takes effect immediately. The
person who started the run cannot approve or reject it, including tasks reached
through a Call. Automated starts have no initiating person. A named audience
member does not gain additional workflow-editing or run-reading permissions.

Eligible requests appear in **Inbox** and **Approvals**. The list defaults to your
waiting requests; choose All in workspace or resolved history to inspect other
requests you can read. Run history also links its tasks. Open a request, optionally
comment, then Approve or Reject. One decision wins. If a response is lost, use
**Retry same decision** to recover that same command rather than sending a new
choice. A competing decision refreshes the recorded result.

In the step's **Inputs**, map `details` to an object of named facts, for example
`{"Customer":"Ada","Amount":120,"Ready":false}`. Use earlier step output or a
normal expression mapping. Up to 20 fields fit in 8 KB; values are text, numbers,
booleans or null. These facts are captured when the task opens and appear on the
request and in Inbox. Later workflow edits do not change an open request. Include
only what the person needs to decide; details are retained run data, visible to
authorized run readers. They are never included in notification emails.

Expiry defaults to 7 days (168 hours). Setup accepts from 1 hour to 30 days. An
expired task fails its step with `pending_task.expired`; attach a failure route if
expiry needs a fallback. Expiry is not a rejection and does not automatically retry
the declaration. Canceled or finished runs cannot accept a late decision.

When no executable work remains except human decisions, the run releases its
active slot and pauses its execution budget. Active steps, ordinary timed Waits,
and retry backoff keep their existing timing. An explicit absolute run deadline
still applies during human waiting. Nested Calls share the existing slot handoff;
continuing work must reacquire capacity before another attempt starts. Approval
and rejection can be recorded while capacity is busy. Expiry and cancellation can
settle without a worker slot, but a failure handler still needs one.

The workspace’s queued-run allowance also bounds outstanding human tasks (100 by
default). An over-budget declaration fails clearly with
`pending_task.capacity_exceeded`. Resolve or cancel outstanding tasks, then replay.
Live input and referenced files remain retained while the run needs them; task
history follows normal run-detail retention and workspace deletion.

Full replay starts fresh tasks. Retry-from-step remains unavailable for workflows
containing human tasks until recovery can prove a durable decision prefix. There
are no email or public approval links, escalations, delegation, or multi-person
voting in this release.
