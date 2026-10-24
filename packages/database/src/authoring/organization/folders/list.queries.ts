import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';
import { FOLDER_LIMIT } from '../limits.js';

import { z } from 'zod';

import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';

import type { createOrganizationSession } from '../session.js';
import { type WorkflowFolderDatabase, folder } from './contract.js';

export function listFolders(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowFolderDatabase['listFolders']>[0],
): ReturnType<WorkflowFolderDatabase['listFolders']> {
  return session.transact(input, async (client, scope) => {
    await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
      actorId: scope.actorId,
      roles: ROLES,
    });
    // One statement derives the whole hierarchy. Count parity fails
    // closed for missing roots, cycles or excessive depth.
    const result = await client.query<{ items: unknown; total: number }>(
      `with recursive bounded as materialized (
          select id,name,parent_id,revision,access_mode from app.workflow_folders where workspace_id=$1 order by id limit 257
        ), tree as (
          select *,1 depth,array[id] path from bounded where parent_id is null
          union all select f.*,t.depth+1,t.path||f.id from bounded f join tree t on f.parent_id=t.id
            where t.depth<5 and not f.id=any(t.path)
        ) select (select count(*)::int from bounded) total,
          coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'parentId',parent_id,'revision',revision,'depth',depth,'accessMode',access_mode) order by id),'[]'::jsonb) items from tree`,
      [scope.workspaceId],
    );
    const row = result.rows[0];
    const access = await readFolderScope(client, scope);
    const items = z.array(folder).max(FOLDER_LIMIT).parse(row?.items);
    if (row?.total !== items.length)
      throw new Error('Workflow folder hierarchy is incompatible');
    return Object.freeze({
      items: Object.freeze(
        items
          .filter((item) => access.permits(item.id, 'workflow:read'))
          .map((item) =>
            Object.freeze({
              ...item,
              canCreateWorkflows: access.permits(item.id, 'workflow:create'),
            }),
          ),
      ),
    });
  });
}
