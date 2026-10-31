# Step retry settings

Choose an action step, open **Setup**, then expand **Retries**. These settings
control how many tries an eligible temporary failure gets and the pause between
tries. They never make an unsafe effect safe to repeat.

| Policy | Behavior |
| --- | --- |
| Platform default | Up to three total tries, with increasing waits, deterministic jitter and any longer bounded delay requested by the service |
| Do not retry | One total try; no automatic logical retry after failure |
| Custom | Two to five total tries, with a fixed wait of 1–60 whole seconds |

The first try counts. **Max tries: 5**, **Wait between tries: 2 seconds** means one
initial attempt and at most four retries. Service execution time comes in
addition to the waits. A service's bounded `Retry-After` can lengthen your wait,
up to one minute. Custom waits have no jitter and are never shortened. Choosing
Platform default removes the override and restores the existing backoff.

Only eligible temporary failures retry. Authentication errors, invalid setup,
permanent service refusals, cancellation and expired run deadlines still stop
work. A possibly dispatched unsafe operation stays `outcome_unknown` and is never
called again automatically. Use the existing explicit recovery/replay controls
when deciding whether to repeat an uncertain effect. **Do not retry** doesn't
change the separate crash-recovery and queue-redelivery safety rules.

A failure path runs only after eligible retries are exhausted. The usual run
failure, error-workflow and notification rules then apply. A waiting retry
releases its worker attempt slot; ordinary run and workflow capacity still apply.
Waits and attempt history are durable, so a worker restart doesn't reset the
configured count. A longer wait never extends the run's deadline, and a run
past its deadline ends even if the worker holding its step has died.

## Versions and tests

Publish to apply a changed policy to new published runs. Existing runs, replay
and recovery use their exact workflow version. Restoring, duplicating,
promoting and exporting/importing a workflow keep its policy. Changing the
policy makes a step's pinned sample stale until it is confirmed or pinned again.

**Test workflow** uses the saved draft's settings. Pinned steps use their sample
and aren't called. **Test step** makes one attempt, just as it did before these
settings; use Test workflow to exercise retries end to end. Test runs keep their
existing retention and notice rules.

Trigger admission and workflow controls don't have retry settings: Condition,
Switch, Parallel, Merge, For each, Wait, Call workflow, Stop run, Approval and
Request input keep their existing coordination behavior. Actions inside loops,
parallel branches and failure paths can have their own settings.

For [HTTP pagination](http-requests.md), each retry starts at the first
page again. Completed pages from a failed attempt are not kept as a partial
result. Retry settings do not change pagination's output or time/size bounds.
