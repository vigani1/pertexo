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
person who started the run cannot approve or reject it by default, including tasks reached
through a Call. Automated starts have no initiating person. A named audience
member does not gain additional workflow-editing or run-reading permissions.

Eligible requests appear in **Inbox** and **Approvals**. The list defaults to your
waiting requests; choose All in workspace or resolved history to inspect other
requests you can read. Run history also links its tasks. Open a request, optionally
comment, then Approve or Reject. One decision wins. If a response is lost, use
**Retry same decision** to recover that same command rather than sending a new
choice. A competing decision refreshes the recorded result.

In the step's **Setup**, use **Add detail** for a label and value. Use **Insert
data** to choose run input, an earlier step output or a workspace variable; the
**Expression** option supports advanced mappings. Whole-object mappings remain
editable in **Inputs**, for example
`{"Customer":"Ada","Amount":120,"Ready":false}`. Use earlier step output or a
normal expression mapping. Up to 20 fields fit in 8 KB; values are text, numbers,
booleans or null, or a list of up to 20 such values (no nested lists/objects).
Choose **List of plain values** for a fixed JSON array such as `["EUR",0,false]`.
These facts are captured when the task opens and appear on the
request and in Inbox. Later workflow edits do not change an open request. Include
only what the person needs to decide; details are retained run data, visible to
authorized run readers. They are never included in notification emails.

Expiry defaults to 7 days. Setup accepts from 1 hour to 30 days and shows the
window as a timeline from the moment the run reaches the step. Under it, **When
nobody responds** decides what an expired task does:

- **Fail the step** (the default) fails it with `pending_task.expired`. A failure
  route can still handle it. Steps saved before this choice existed keep this
  behaviour.
- **Continue on Timed out** adds a **Timed out** output to the step. The run
  carries on along that path instead of failing.

Expiry is neither a rejection nor a retry. Once a task has expired, nobody can
answer it, and a late decision cannot bring it back. Canceled or finished runs
cannot accept a late decision either. A task refused because too many tasks are
outstanding still fails the step; that is not a timeout.

### How the Timed out path works

The Timed out output appears on the canvas only after you choose **Continue on
Timed out**. It has its own amber hourglass and dashed line, apart from the
success paths and the red Failure path. While Timed out is linked, the setup
keeps it chosen; remove the link to fail the step instead. Publishing with
Timed out chosen but not linked is allowed, like any other unlinked output; the
run then simply ends on that path.

When nobody answers in time, the step succeeds with this output:

```json
{
  "timedOut": true,
  "openedAt": "2026-10-20T09:00:00.000Z",
  "expiredAt": "2026-10-27T09:00:00.000Z",
  "audience": { "roles": ["owner", "admin"], "memberIds": [] },
  "details": { "Customer": "Ada", "Amount": 120 }
}
```

`openedAt` is when the request opened and `expiredAt` when its window ended.
`audience` names who was asked, and `details` repeats the captured details, so
a later step can say who was asked and when. Run detail shows the step as
"Timed out after 7 days" and highlights the path the run took.

Two common patterns:

- **Escalate.** Link Timed out to a **Send email** or **Send Slack message** step
  that tells a manager, then to a second Approval for that manager.
- **Default decision.** To treat silence as approval, link Timed out to the same
  next step as Approved. The canvas shows both links, so the default is visible.
  Prefer escalation for anything with real consequences.

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
containing human tasks until recovery can prove a durable decision prefix.

Later work: reminders before expiry, reassigning an open task, email or public
approval links, delegation and multi-person voting are not available in this
release. Escalate through the Timed out path instead.

In Approval setup, **Allow the person who started the run to decide** is an optional
per-step choice, off by default. It is saved when each task opens. The editor
checks the whole current audience and warns when a run you start would leave no
other decider. Allowing the starter still requires current membership, run-read
access and the selected audience; expiry and cancellation still close the task.

Approval output includes `decidedByName`, recorded when the decision is accepted.
Later profile edits do not change it. Use `decidedBy` for stable user identity and
the recorded name for display. Earlier decisions may not contain this field.

[Desktop setup](../media/approvals/starter-desktop.png) ·
[Phone setup](../media/approvals/starter-phone.png)
