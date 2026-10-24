import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowTestSuiteCurrent } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { WorkflowTestError } from '../workflows/contract.js';
/** The same metadata signature prepares suites and labels publish freshness. */
export async function readSuiteCurrent(
  client: PoolClient,
  input: SampleScope,
  frozenVariableSetRevision?: number | null,
): Promise<WorkflowTestSuiteCurrent> {
  const draft = await client.query<{ revision: number }>(
    'select revision from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    [input.workspaceId, input.workflowId],
  );
  const revision = draft.rows[0]?.revision;
  if (revision === undefined) throw new WorkflowTestError('not_found');
  const cases = await client.query<{
    id: string;
    revision: number;
    name: string;
  }>(
    'select id,revision,name from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2 and deleted_at is null order by created_at,id limit 51',
    [input.workspaceId, input.workflowId],
  );
  if (cases.rows.length > 50) throw new WorkflowTestError('cases_changed');
  const pins = await client.query<{
    node_id: string;
    id: string;
    expired: boolean;
  }>(
    'select node_id,id,expires_at<=clock_timestamp() expired from app.workflow_step_samples where workspace_id=$1 and workflow_id=$2 order by node_id',
    [input.workspaceId, input.workflowId],
  );
  const variables =
    frozenVariableSetRevision === undefined
      ? await client.query<{ revision: number }>(
          'select revision from app.workspace_variables where workspace_id=$1',
          [input.workspaceId],
        )
      : undefined;
  const variableSetRevision =
    frozenVariableSetRevision === undefined
      ? (variables?.rows[0]?.revision ?? null)
      : frozenVariableSetRevision;
  const identity = {
    draftRevision: revision,
    cases: cases.rows.map(({ id, revision }) => ({ id, revision })),
    samples: pins.rows.map((row) => ({
      nodeId: row.node_id,
      sampleId: row.id,
    })),
    variableSetRevision,
  };
  return {
    ...identity,
    cases: cases.rows,
    signature: createHash('sha256')
      .update(
        canonicalJson({
          ...identity,
          expiredSampleIds: pins.rows
            .filter((pin) => pin.expired)
            .map((pin) => pin.id),
        }),
      )
      .digest('hex'),
  };
}
