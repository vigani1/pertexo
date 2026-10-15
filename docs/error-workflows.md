# Run a workflow when another fails

Use an error workflow for work such as recording an incident or notifying an
internal service after a run fails. It is separate from an **On failure** link,
which handles a step's failure inside the original run.

1. Create a workflow with **When a workflow fails** as its entry. Map its output
   into the steps that should handle the failure, then publish it.
2. Open the original workflow's **Settings → Error workflow**. Choose the
   published workflow under **When this workflow fails, run …**, then save.
   You need edit access to both workflows in the same workspace.
3. After a failed run, open its detail. The error-workflow notice links to the
   new error run, or explains why it could not start.

The trigger receives only this safe summary:

```json
{
  "workflow": {
    "id": "01900000-0000-7000-8000-000000000001",
    "name": "Import invoices",
    "versionId": "01900000-0000-7000-8000-000000000002"
  },
  "run": {
    "id": "01900000-0000-7000-8000-000000000003",
    "url": "/w/01900000-0000-7000-8000-000000000004/runs/01900000-0000-7000-8000-000000000003",
    "status": "failed"
  },
  "failedStep": { "id": "fetch-invoices" },
  "error": {
    "code": "execution.failed",
    "message": "The workflow failed."
  }
}
```

The run link is relative to your Pertexo site. `failedStep` is null for a
run-level failure without a failing step. Error descriptions are fixed Pertexo
text: provider messages, response bodies, stacks, credentials, run input and
step outputs are never included. For example, map `$.run.url` from the trigger's
output into a notification's link field. The linked run's normal permissions
still apply.

Failed, timed-out and unknown-outcome runs each start at most one error run.
An unknown outcome still means an operation may have taken effect; inspect the
service before repeating it. Error workflows do not change automatic retry or
recovery rules. A successful failure route and a canceled run do not start an
error workflow. If a failure route itself fails, the final run failure does.

The target publication is captured when the source fails. Later changes to the
setting or publication affect later failures. Error runs use the normal run
queue, limits and current credentials. An archived or incompatible target,
unavailable workspace or full queue can refuse admission; the original failure
is still recorded. Target history expires under the normal retention policy.

An error workflow's own failure never starts another error workflow. Child
Calls, replays and recoveries keep that origin too, preventing indirect loops.
No email address, account, external service or public link is required to use
this feature; add external notification steps only when you want those effects.
