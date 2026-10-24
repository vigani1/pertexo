import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowFolders } from '../../../schema/authoring/organization.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { folderProjection, type FolderRow } from './hierarchy.queries.js';
import { readFolderScope } from '../../../tenant-access/resources/facts.queries.js';
import { FOLDER_LIMIT, FOLDER_DEPTH_LIMIT } from '../limits.js';

import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../../workflows/authority.js';

import type { createOrganizationSession } from '../session.js';
import type { WorkflowFolderDatabase } from './contract.js';

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
    const db = drizzle(client);
    const bounded = db
      .select(folderProjection)
      .from(workflowFolders)
      .where(eq(workflowFolders.workspaceId, scope.workspaceId))
      .orderBy(asc(workflowFolders.id))
      .limit(FOLDER_LIMIT + 1);
    const result = await db
      .execute<{ items: (FolderRow & { depth: number })[]; total: number }>(
        sql`
      with recursive bounded as materialized (${bounded}),tree as (
        select *,1 depth,array[id] path from bounded where parent_id is null
        union all select f.*,t.depth+1,t.path||f.id from bounded f join tree t on f.parent_id=t.id
          where t.depth<${FOLDER_DEPTH_LIMIT + 1} and not f.id=any(t.path)
      ) select (select count(*)::int from bounded) total,
        coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'parentId',parent_id,'revision',revision,'depth',depth,'accessMode',access_mode) order by id),'[]'::jsonb) items from tree
    `,
      )
      .catch(rethrowQueryFailure);
    const row = result.rows[0];
    const access = await readFolderScope(client, scope);
    const items = row?.items ?? [];
    const hierarchyCompatible =
      items.length <= FOLDER_LIMIT &&
      row?.total === items.length &&
      items.every((item) => item.depth <= FOLDER_DEPTH_LIMIT);
    if (!hierarchyCompatible)
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
