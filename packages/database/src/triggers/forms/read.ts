import { readFormDefinition } from './definition.js';
import type { PoolClient } from 'pg';
import { parsePublishedWorkflowRow } from '../../runs/queries/published-workflow.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../tenant-access/workspaces/authority.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import {
  FormUnavailableError,
  type FormScope,
  type PublicFormGrant,
} from './contract.js';

export async function authorizeForm(
  client: PoolClient,
  input: FormScope,
  grant: PublicFormGrant | undefined,
  write: boolean,
  manage = false,
): Promise<void> {
  if (grant !== undefined) {
    if (
      input.workspaceId !== grant.workspaceId ||
      input.workflowId !== grant.workflowId
    )
      throw new FormUnavailableError();
    const current = await client.query(
      `select 1 from app.workflow_forms where workspace_id=$1 and workflow_id=$2 and public_id=$3 and access='public' and capability_hash=$4 and node_id=$5 ${write ? 'for share' : ''}`,
      [
        input.workspaceId,
        input.workflowId,
        grant.publicId,
        grant.capabilityHash,
        grant.nodeId,
      ],
    );
    if (current.rowCount !== 1) throw new FormUnavailableError();
  } else {
    if (input.actorId === undefined) throw new FormUnavailableError();
    await (write ? lockWorkspaceAuthority : readWorkspaceAuthority)(
      client,
      input.workspaceId,
      input.actorId,
      rolesForCapability(manage ? 'workflow:update' : 'workspace:read'),
    );
  }
}
export async function readFormVersion(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  allowPaused = false,
) {
  const result = await client.query<{
    id: string;
    workspace_id: string;
    workflow_id: string;
    version_number: number;
    checksum: string;
    executable_json: unknown;
    graph_json: unknown;
  }>(
    `select version.graph_json,version.id,version.workspace_id,version.workflow_id,version.version_number,version.checksum,version.executable_json
    from app.workflows workflow join app.workspaces workspace on workspace.id=workflow.workspace_id and workspace.status='active' join app.workflow_versions version on version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id and version.id=workflow.published_version_id
    where workflow.workspace_id=$1 and workflow.id=$2 and workflow.lifecycle_status='active' and ($3::boolean or workflow.trigger_pause_state='none') ${locking === 'read' ? '' : `for ${locking} of workflow`}`,
    [input.workspaceId, input.workflowId, allowPaused],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FormUnavailableError();
  const { graph_json, ...projection } = row;
  const version = parsePublishedWorkflowRow(projection);
  if (version === null) throw new FormUnavailableError();
  return { version, ...readFormDefinition(graph_json) };
}
