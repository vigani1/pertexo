import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model/graph';
import {
  validateWorkflowCallClosureV1,
  validateWorkflowCallableGraphV2,
  workflowCallableContractIdentityV1,
  WorkflowCallClosureError,
  type PublishedCallableVersionV1,
} from '@pertexo/workflow-model/workflow-call-closure';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  type WorkflowCallPinV1,
} from '@pertexo/workflow-model/workflow-call-contract';
import type { PublishWorkflowInput } from './workflow-authoring-contracts.js';
import {
  mapVersion,
  workflowVersionRowSelection,
} from './workflow-authoring-rows.js';

/** Private resolver suspension; never reinterpret a database failure as a missing pin. */
class UnresolvedPublicationPin extends Error {
  public constructor(public readonly pin: Readonly<WorkflowCallPinV1>) {
    super('Immutable publication pin needs resolution');
  }
}

export async function validateNativePublicationClosure(
  client: PoolClient,
  input: PublishWorkflowInput,
  graph: WorkflowGraph,
): Promise<void> {
  const versions = new Map<string, PublishedCallableVersionV1>();
  for (;;) {
    input.signal?.throwIfAborted();
    try {
      validateWorkflowCallClosureV1({
        workflowId: input.workflowId,
        graph,
        resolve: (pin) => {
          const version = versions.get(pin.versionId);
          if (version === undefined) throw new UnresolvedPublicationPin(pin);
          return version;
        },
      });
      return;
    } catch (error) {
      if (!(error instanceof UnresolvedPublicationPin)) throw error;
      if (versions.size >= WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns)
        throw new WorkflowCallClosureError('child_limit');
      const pin = error.pin;
      const result = await client.query<Record<string, unknown>>(
        `select ${workflowVersionRowSelection},executable_schema_version
         from app.workflow_versions
         where workspace_id=$1 and workflow_id=$2 and id=$3`,
        [input.workspaceId, pin.workflowId, pin.versionId],
      );
      input.signal?.throwIfAborted();
      const row = result.rows[0];
      if (row === undefined)
        throw new WorkflowCallClosureError('missing_version');
      const { executable_schema_version: executableVersion, ...versionRow } =
        row;
      const version = mapVersion(versionRow);
      if (
        version.workspaceId !== input.workspaceId ||
        version.workflowId !== pin.workflowId ||
        version.id !== pin.versionId ||
        version.schemaVersion !== 2 ||
        executableVersion !== 3 ||
        version.checksum !== pin.checksum
      )
        throw new WorkflowCallClosureError('pin_mismatch');
      const callee = validateWorkflowCallableGraphV2(version.graphJson);
      if (callee.callable === undefined)
        throw new WorkflowCallClosureError('not_callable');
      versions.set(pin.versionId, {
        workflowId: version.workflowId,
        versionId: version.id,
        checksum: version.checksum,
        callableContractIdentity: workflowCallableContractIdentityV1(
          callee.callable,
        ),
        graph: callee,
      });
    }
  }
}
