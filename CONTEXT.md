# Workflow Platform

The platform authors reusable workflows and executes immutable published
versions while preserving operational history.

## Language

**Workspace notice**: A thread about a workflow failure or current operational
attention: an auto-pause, connection health, workspace capacity, or waiting
approval. Membership, the subject's audience and personal follow/mute choices
shape each person's Inbox. _Avoid_: Run event, shared failure alert, pending
task

**Personal notification preference**: One member's email schedule and subject
follow/mute choices. Following grants no extra access; muting changes neither
shared workflow alerts nor the underlying human task. _Avoid_: Workspace alert
destination, approval decision, credential

**Workflow link**: A directed relationship from one step’s output to another
step’s input, within a workflow or a loop body. Links determine when steps run;
input mappings determine the data they receive. _Avoid_: Connection, credential

**Workflow connection**: A workspace’s named credentials for an external
service, referenced by workflow steps. _Avoid_: Workflow link, sign-in method

**Workflow organization**: Shared workspace metadata that helps people discover
and arrange workflows without changing their behavior or access. _Avoid_:
Workflow graph, permission inheritance

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

**Run replay**: A new execution with an explicitly selected retained version and
input, linked to a source run whose history remains unchanged. _Avoid_: Queue
redelivery, retry

**Recovery run**: A new execution of a failed run's same immutable version and
input that reuses its eligible completed prefix and runs from the failed step
onward. Its source history stays unchanged. _Avoid_: Resuming the source run,
full replay, automatic retry

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
[the guide](docs/variables.md) and
[ADR 078](docs/adr/078-run-variable-snapshots.md).
