import type { PoolClient } from 'pg';

import type {
  WorkflowHistory,
  WorkflowLifecycleState,
} from './contract.js';

export async function readWorkflowHistory(
  withApi: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  workflowId: string,
): Promise<WorkflowHistory> {
  return withApi(async (client) => {
    const draft = await client.query<{
      revision: number;
      graph_json: unknown;
    }>(
      `select revision,graph_json
       from app.workflow_drafts where workflow_id=$1`,
      [workflowId],
    );
    const versions = await client.query<{
      id: string;
      checksum: string;
      graph_json: unknown;
      version_number: number;
    }>(
      `select id,checksum,graph_json,version_number
       from app.workflow_versions where workflow_id=$1
       order by version_number,id`,
      [workflowId],
    );
    const runs = await client.query<{
      id: string;
      status: string;
      workflow_version_id: string;
    }>(
      `select id,status,workflow_version_id
       from app.workflow_runs where workflow_id=$1 order by id`,
      [workflowId],
    );
    const draftRow = draft.rows[0];
    if (draftRow === undefined) throw new Error('workflow draft missing');
    return {
      draft: {
        revision: draftRow.revision,
        graph: draftRow.graph_json,
      },
      versions: versions.rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        graph: row.graph_json,
        versionNumber: row.version_number,
      })),
      runs: runs.rows.map((row) => ({
        id: row.id,
        status: row.status,
        workflowVersionId: row.workflow_version_id,
      })),
    };
  });
}

export async function readWorkflowLifecycle(
  withApi: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>,
  workflowId: string,
): Promise<WorkflowLifecycleState> {
  return withApi(async (client) => {
    const result = await client.query<{
      lifecycle_status: WorkflowLifecycleState['lifecycleStatus'];
      lifecycle_revision: number;
      activation_status: WorkflowLifecycleState['activationStatus'];
      published_version_id: string | null;
    }>(
      `select lifecycle_status,lifecycle_revision,activation_status,
              published_version_id
       from app.workflows where id=$1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow lifecycle state missing');
    return {
      lifecycleStatus: row.lifecycle_status,
      lifecycleRevision: row.lifecycle_revision,
      activationStatus: row.activation_status,
      publishedVersionId: row.published_version_id,
    };
  });
}
