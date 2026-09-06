# Workflow Platform

The platform authors reusable workflows and executes immutable published
versions while preserving operational history.

## Language

**Workflow lifecycle**:
Whether a workflow is active or archived. Archiving pauses new admission, not
the history or progress of runs that already exist.
_Avoid_: Run status, activation health

**Workflow activation**:
The readiness and health of a published workflow's triggers. A workflow's
existence as an active authoring object does not imply healthy activation.
_Avoid_: Workflow lifecycle, publication status

**Workflow restoration**:
Returning an archived workflow to its active lifecycle with its retained
publication and configuration.
_Avoid_: Version restoration, replay

**Version restoration**:
Replacing the editable draft with a retained published version's graph. It is
an authoring operation, not a publication or execution.
_Avoid_: Workflow restoration, rollback of execution history

**Run replay**:
A new execution with an explicitly selected retained version and input, linked
to a source run whose history remains unchanged.
_Avoid_: Queue redelivery, retry
