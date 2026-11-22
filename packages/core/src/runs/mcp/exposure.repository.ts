import { and, asc, eq, sql } from 'drizzle-orm';
import { workflows } from '@pertexo/database/schema';
import type { ResourceTransaction } from '../../shared/access/folder-access.types.js';
import { workflowScopeSql } from '../../shared/access/folder-scope.repository.js';

const projection = {
  id: workflows.id,
  exposure: workflows.mcpExposure,
  versionId: workflows.publishedVersionId,
  lifecycle: workflows.lifecycleStatus,
  pause: workflows.triggerPauseState,
};

type McpExposure = NonNullable<(typeof workflows.$inferSelect)['mcpExposure']>;

export function activeExposure(row: {
  exposure: McpExposure | null;
  versionId: string | null;
  lifecycle: string;
}): McpExposure | undefined {
  if (row.lifecycle === 'active' && row.exposure?.versionId === row.versionId)
    return row.exposure;
  return undefined;
}

export async function readMcpWorkflow(
  transaction: ResourceTransaction,
  workflowId: string,
  mode: 'read' | 'invoke' | 'manage' | 'settings',
) {
  const query = transaction.db
    .select(projection)
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflows.id}`,
          mode === 'manage' || mode === 'settings'
            ? 'workflow:publish'
            : 'run:start',
        ),
      ),
    );
  const locks = { manage: 'no key update', invoke: 'share' } as const;
  const lock = mode === 'manage' || mode === 'invoke' ? locks[mode] : undefined;
  const [row] = await (lock === undefined ? query : query.for(lock));
  return row;
}

const MCP_TOOL_PAGE_LIMIT = 10;
export function listMcpWorkflows(
  transaction: ResourceTransaction,
  locator: { name: string } | { after: string | undefined },
) {
  const name = sql<string>`${workflows.mcpExposure}->>'name'`;
  const after = 'after' in locator ? locator.after : undefined;
  return transaction.db
    .select(projection)
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.lifecycleStatus, 'active'),
        sql`${workflows.mcpExposure}->>'versionId'=${workflows.publishedVersionId}::text`,
        'name' in locator ? eq(name, locator.name) : undefined,
        after === undefined ? undefined : sql`${name}>${after}`,
        workflowScopeSql(
          transaction.resources,
          sql`${workflows.id}`,
          'run:start',
        ),
      ),
    )
    .orderBy(asc(name))
    .limit('name' in locator ? 1 : MCP_TOOL_PAGE_LIMIT + 1);
}
export { MCP_TOOL_PAGE_LIMIT };
