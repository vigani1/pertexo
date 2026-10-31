# Workflow Platform

The platform authors reusable workflows and executes immutable published
versions while preserving operational history.

## Language

**Identity organization**: Explicitly linked workspaces whose verified domains,
sign-in providers and directory-managed memberships are controlled by one
workspace owner. _Avoid_: Workflow organization, a new workspace role

**Directory-managed membership**: Access in one workspace whose role and status
follow an identity organization's provisioning policy. Other memberships remain
independent. _Avoid_: Global account suspension, provider account ownership
proof

**Workspace notice**: A thread about a workflow failure, operational attention
or an explicit comment mention. Membership, the subject's audience and personal
follow/mute choices shape each person's Inbox. _Avoid_: Run event, shared
failure alert, pending task

**Personal notification preference**: One member's email schedule and subject
follow/mute choices. Following grants no extra access; muting changes neither
shared workflow alerts nor the underlying human task. _Avoid_: Workspace alert
destination, approval decision, credential

**Workflow comment thread**: A discussion about a workflow or one stable step,
shared with the people who may read that workflow. Resolving a discussion does
not change the workflow. _Avoid_: Inbox notice, run event, approval request

**Canvas note**: Markdown documentation positioned on a workflow canvas and
retained in its draft and published versions. It never participates in execution
or changes a pinned sample binding. _Avoid_: Comment thread, step, run data

**Editing presence**: An advisory indication of who is viewing or editing a
workflow and who has unsaved changes. It grants no access and does not merge
edits or replace draft concurrency checks. _Avoid_: Edit lock, multiplayer

**Workflow link**: A directed relationship from one step’s output to another
step’s input, within a workflow or a loop body. Links determine when steps run;
input mappings determine the data they receive. _Avoid_: Connection, credential

**Workflow connection**: A workspace’s named credentials for an external
service, referenced by workflow steps. _Avoid_: Workflow link, sign-in method

**Workflow organization**: Shared workspace metadata that helps people discover
and arrange workflows. Folder access grants are separate from that metadata.
_Avoid_: Workflow graph, access grant

**Folder access grant**: Permission for a member or directory group to view or
edit a folder’s workflows within their workspace role. Restricted ancestors may
narrow that permission. _Avoid_: Workspace membership, workspace role, workflow
ownership

**Connection sharing**: Permission to use a workflow connection in authoring and
testing without receiving its secret or administration rights. _Avoid_: Copying
credentials, workflow access, workspace membership

**Workflow tag**: A shared workspace label with stable identity that can be
assigned to workflows independently of their names and lifecycle. _Avoid_:
Personal bookmark, node label

**Workflow favorite**: One person's private bookmark of a workflow they may
currently read. It is not a team recommendation or an access grant. _Avoid_:
Shared tag, activation, permission

**Connection health**: Evidence that a workflow connection's current credential
is usable or requires reauthorization. A failed operation is not necessarily an
unhealthy connection. _Avoid_: Provider availability, run status

**Connection usage**: The retained published workflow versions that reference a
workflow connection, including historical publications. _Avoid_: Draft usage,
current-workflow count

**Workflow lifecycle**: Whether a workflow is active or archived. Archiving
pauses new admission, not the history or progress of runs that already exist.
_Avoid_: Run status, activation health

**Workflow activation**: The readiness and health of a published workflow's
triggers. A workflow's existence as an active authoring object does not imply
healthy activation. _Avoid_: Workflow lifecycle, publication status

**Workflow restoration**: Returning an archived workflow to its active lifecycle
with its retained publication and configuration. _Avoid_: Version restoration,
replay

**Version restoration**: Replacing the editable draft with a retained published
version's graph. It is an authoring operation, not a publication or execution.
_Avoid_: Workflow restoration, rollback of execution history

**Publication review**: A request for a different current owner/admin to publish
one exact saved draft revision when workspace approval is required. Editing the
draft makes the request stale. Approval and publication commit together.
_Avoid_: Run approval, permission to publish future edits

**Promotion target**: Another workspace on this install selected as the
destination for reviewed workflow changes. It grants no access or shared
configuration. _Avoid_: Deployment server, shared secret store

**Workflow promotion**: Applying a reviewed published version as a separate
workspace's draft, with its own connections and configuration. Publishing there
still follows that workspace's approval rules. _Avoid_: Moving a workflow,
replaying a run, copying an environment

**Promoted version counterpart**: An immutable target version published from a
reviewed source version after its references were bound to the target. Calls use
that exact correspondence. _Avoid_: Latest child version, matching workflow name

**Run replay**: A new execution with an explicitly selected retained version and
input, linked to a source run whose history remains unchanged. _Avoid_: Queue
redelivery, retry

**Recovery run**: A new execution of a failed run's same immutable version and
input that reuses its eligible completed prefix and runs from the failed step
onward. Its source history stays unchanged. _Avoid_: Resuming the source run,
full replay, automatic retry

**Stalled run**: An active run whose next step passed its recorded time with
nothing acting on it yet. A worker recovers it automatically, without repeating
a step that may have reached a provider; it is a notice, not a run status.
_Avoid_: Crashed run, zombie run

**Reused step**: A step's retained result copied into a recovery run without
executing that step there. _Avoid_: A new successful attempt, provider retry,
execution cache

**Failure link**: A workflow link that selects an alternative path after an
eligible definite failure finishes its automatic retries. _Avoid_: Workflow
connection, failure alert, finally block

**Failure handler**: The alternative path owned by one failure link, executed
within the same run. _Avoid_: Child run, automatic retry, full replay

**Handled failure**: A failed step whose selected failure handler completed
successfully. The step remains failed; handling does not prove that its original
business operation succeeded. _Avoid_: Successful attempt, ignored failure

**Callable workflow**: A reusable workflow that declares the input it accepts
and the result it returns. It can run on its own. _Avoid_: A loop body, a
different trigger kind

**Workflow Call**: One scoped Call workflow step that pins an immutable callable
version in the same workspace and waits for a separate child run’s validated
result. Its identity includes branch and iteration scope. _Avoid_: Preview,
recursive in-process execution, a mutable target

**Child run**: A separate ordinary execution accepted by a Workflow Call. It can
call another workflow and become a parent itself. A waiting parent lends its
workspace active-run slot to one child and takes it back when the child settles.
_Avoid_: A nested For Each body, another workspace slot, a synthetic manual
start

**Run-input case**: A named, shared workflow input with an explicit published
version context. Loading it supplies editable input for a separately confirmed
real manual run; it is not an execution or a substitute for provider effects.
_Avoid_: Replay, preview, mock, pinned sample

**Webhook endpoint**: The address, secret and delivery history of a webhook
step. It belongs to the workflow and that step, so publishing never changes it;
it stops answering only while the published version doesn't contain the step.

**Webhook reply**: A JSON or text response chosen once by an original webhook
run for its waiting caller. Sending it does not end the run; a bounded wait can
instead return the accepted run reference. _Avoid_: Run result, Call result,
trigger admission

**Draft workflow test**: An execution of a saved draft using captured pins for
pinned steps and real execution for other steps. Its history stays in the
editor; it never publishes the draft or sends normal run notifications. _Avoid_:
Published run, simulation, test suite

**Pinned sample**: Shared output attached to one draft step for editor tests. It
replaces that step's execution during a test and becomes stale when its setup
changes. _Avoid_: Published output, execution cache, run-input case

**Pertexo account**: A person's stable identity across their workspace
memberships, independent of which sign-in method they use. _Avoid_: Workspace,
provider account

**API token**: A personal credential for approved workflow and run operations in
one workspace. Its scopes limit the owner's current permissions; membership
changes invalidate it. It is shown once and expires or can be revoked. _Avoid_:
Workflow connection, sign-in method, master key, service account

**Sign-in method**: A credential or external identity used to authenticate a
Pertexo account; it grants no workflow-service access by itself. _Avoid_:
Workflow connection

**Account linking**: Adding a proven sign-in method to one existing Pertexo
account without transferring workspace memberships or combining users. _Avoid_:
Account merging

**Error workflow**: A separate workflow started once after another run ends in
an unhandled failure. It receives only a safe failure summary. Its own run
family never starts another error workflow. _Avoid_: Failure route, recovery,
replay

## Workspace variables

A **workspace variable** is a non-secret named text, finite number or boolean
shared by current workspace members. Owners and admins manage the current set.
Names use uppercase identifiers; mappings display direct typed references as
`$vars.NAME`, and existing JSONata expressions may compute with the same
binding.

A **variable set revision** is one immutable workspace map of values and
optional descriptions, stored once per change. A **variable snapshot** is its
revision and value map captured at run admission; executions store only a
workspace-bound reference. Revision zero is the fixed empty set. Independent
runs and previews capture current configuration; replay, step recovery and
nested child workflows retain their source or parent's set. An error workflow is
independent and captures current values. Workers never look up mutable
configuration while executing. Snapshots expire with execution details; missing
historical snapshots refuse replay rather than substitute current values. See
[the guide](docs/guides/variables.md) and
[ADR 078](docs/adr/078-run-variable-snapshots.md).

## Workspace data tables

A **data table** is a workspace-owned, bounded dataset with typed columns and
stable column identities and an optional single unique key. Its stable name is
what workflow steps and portable workflow files reference. A **data row** has
its own ID and revision; interactive edits compare that revision to avoid lost
updates. Table data is shared with active workspace members and is not secret
storage.

A **table write receipt** records a workflow mutation and its bounded result in
the same transaction as the row change. The identity is the run/node invocation,
so attempts reuse the result after a lost acknowledgement. New replay runs have
new identities. Receipts follow execution retention; table rows persist until
explicit deletion or workspace purge. See
[ADR 083](docs/adr/083-workspace-data-tables.md) and the
[data tables guide](docs/guides/data-tables.md).

### Trigger event coordination

An optional published Webhook/Form policy groups business events by a typed,
canonical hashed input key. Deduplicate suppresses matches in a fixed window;
Debounce retains the latest event until quiet; Throttle bounds admissions and
skips or delays excess in arrival order. A pending event is accepted input, not
a run. Run admission, transport replay and execution retries retain separate
meanings. See [ADR 084](docs/adr/084-durable-trigger-event-coordination.md) and
the [event coordination guide](docs/guides/event-coordination.md).
