import type { OrganizationRequestScope } from '../session.js';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowFolders } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { folderProjection, type FolderRow } from './hierarchy.repository.js';
import { readBrowsableFolderScope } from '../../../shared/facts.repository.js';
import { FOLDER_DEPTH_LIMIT } from '../limits.js';
import { FOLDER_LIMIT } from '../../../shared/folder-policy.js';

import type { createOrganizationSession } from '../session.js';
import type { WorkflowFolderRecord } from './workflow-folder.types.js';

export function listFolders(
  session: ReturnType<typeof createOrganizationSession>,
  input: OrganizationRequestScope,
): Promise<Readonly<{ items: readonly WorkflowFolderRecord[] }>> {
  return session.read(
    input,
    'workflow:read',
    BROWSABLE_WORKSPACE_STATUSES,
    async (client, scope) => {
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
      const access = await readBrowsableFolderScope(client, scope);
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
    },
  );
}
