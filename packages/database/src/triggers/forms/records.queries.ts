import { rolesForCapability } from '@pertexo/workflow-model';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import { readFormDefinition } from './definition.js';
import type { PoolClient } from 'pg';
import { parsePublishedWorkflowRow } from '../../runs/queries/execution/published.js';
import {
  FormUnavailableError,
  type FormScope,
  type PublicFormGrant,
} from './contract.js';

export async function authorizeForm(
  client: PoolClient,
  input: FormScope,
  {
    grant,
    write,
    manage = false,
  }: Readonly<{
    grant: PublicFormGrant | undefined;
    write: boolean;
    manage?: boolean | undefined;
  }>,
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
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, actorId: input.actorId },
        {
          capability: manage && write ? 'workflow:update' : 'workflow:read',
          locking: write,
          roles: rolesForCapability(
            manage ? 'workflow:update' : 'workspace:read',
          ),
        },
      ))
    )
      throw new FormUnavailableError();
  }
}
export async function readFormVersion(
  client: PoolClient,
  input: FormScope,
  locking: 'read' | 'share' | 'update',
  { allowPaused = false }: Readonly<{ allowPaused?: boolean | undefined }> = {},
) {
  // Lock before reading the version: a locked join waiting on a concurrent
  // publication re-checks against the old version row and finds no form.
  const workflow = await client.query<{ published_version_id: string | null }>(
    `select workflow.published_version_id
    from app.workflows workflow join app.workspaces workspace on workspace.id=workflow.workspace_id and workspace.status='active'
    where workflow.workspace_id=$1 and workflow.id=$2 and workflow.lifecycle_status='active' and ($3::boolean or workflow.trigger_pause_state='none') ${locking === 'read' ? '' : `for ${locking} of workflow`}`,
    [input.workspaceId, input.workflowId, allowPaused],
  );
  const publishedVersionId = workflow.rows[0]?.published_version_id;
  if (publishedVersionId === undefined || publishedVersionId === null)
    throw new FormUnavailableError();
  const result = await client.query<{
    id: string;
    workspace_id: string;
    workflow_id: string;
    version_number: number;
    checksum: string;
    executable_json: unknown;
    graph_json: unknown;
  }>(
    `select graph_json,id,workspace_id,workflow_id,version_number,checksum,executable_json
    from app.workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3`,
    [input.workspaceId, input.workflowId, publishedVersionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FormUnavailableError();
  const { graph_json, ...projection } = row;
  const version = parsePublishedWorkflowRow(projection);
  if (version === null) throw new FormUnavailableError();
  return { version, ...readFormDefinition(graph_json) };
}
