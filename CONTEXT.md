# Workflow Platform

The platform authors reusable workflows and executes immutable published
versions while preserving operational history.

## Language

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

**Callable workflow**: A reusable workflow that declares the input it accepts
and the result it returns. It can run on its own. _Avoid_: A loop body, a
different trigger kind

**Run-input case**: A named, shared workflow input with an explicit published
version context. Loading it supplies editable input for a separately confirmed
real manual run; it is not an execution or a substitute for provider effects.
_Avoid_: Replay, preview, mock, pinned sample

**Pertexo account**: A person's stable identity across their workspace
memberships, independent of which sign-in method they use. _Avoid_: Workspace,
provider account

**Sign-in method**: A credential or external identity used to authenticate a
Pertexo account; it grants no workflow-service access by itself. _Avoid_:
Workflow connection

**Account linking**: Adding a proven sign-in method to one existing Pertexo
account without transferring workspace memberships or combining users. _Avoid_:
Account merging
