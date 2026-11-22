import type { Pool } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { readResourceTransaction } from '../../shared/access/folder-access-facts.repository.js';
import { withWorkspaceAccess } from '../../shared/access/workspace-access.js';
import {
  listMcpWorkflows,
  MCP_TOOL_PAGE_LIMIT,
} from './exposure.repository.js';
import { callableTool } from './callable-tool.js';
import type { McpCaller } from './invoke-tool.js';
import { findPublishedWorkflow } from '../queries/execution/published.repository.js';
import type { PersistedWorkflowProjectionVerificationOptions } from '../queries/execution/verify-projection.js';

export function listMcpTools(
  pool: Pool,
  verification: PersistedWorkflowProjectionVerificationOptions,
  input: McpCaller & Readonly<{ after?: string | undefined }>,
) {
  return withWorkspaceAccess(
    pool,
    input,
    {
      capability: 'mcp:invoke',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      mode: 'read',
    },
    async (client, role) => {
      const transaction = await readResourceTransaction(client, input, role);
      const workflows = await listMcpWorkflows(transaction, {
        after: input.after,
      });
      const page = workflows.slice(0, MCP_TOOL_PAGE_LIMIT);
      const tools = [];
      for (const { id, exposure } of page) {
        if (exposure === null) continue;
        const version = await findPublishedWorkflow(transaction.db, {
          workspaceId: input.workspaceId,
          workflowId: id,
          id: exposure.versionId,
        });
        if (version === null) continue;
        const tool = callableTool(version, verification);
        if (tool?.entryId === exposure.entryId)
          tools.push({
            name: exposure.name,
            description: exposure.description,
            inputSchema: tool.inputSchema,
          });
      }
      const nextCursor =
        workflows.length > page.length
          ? page.at(-1)?.exposure?.name
          : undefined;
      return { tools, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  );
}
