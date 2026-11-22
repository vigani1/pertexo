import type { Pool } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { readResourceTransaction } from '../../shared/access/folder-access-facts.repository.js';
import { withWorkspaceAccess } from '../../shared/access/workspace-access.js';
import { commandKeyHash } from '../../shared/command-fingerprints.js';
import { readMcpWorkflow } from './exposure.repository.js';
import type { McpCaller } from './invoke-tool.js';
import { readMcpInvocation } from './invocation.repository.js';
import { McpToolUnavailableError } from './mcp.errors.js';
import { TERMINAL_RUN_STATUSES } from '../statuses.js';

export function readMcpToolStatus(
  pool: Pool,
  input: McpCaller & Readonly<{ runId: string; invocation: string }>,
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
      const run = await readMcpInvocation(transaction, {
        runId: input.runId,
        tokenId: input.tokenId,
        referenceDigest: commandKeyHash(input.invocation),
      });
      if (run === undefined) throw new McpToolUnavailableError();
      const workflow = await readMcpWorkflow(
        transaction,
        run.workflowId,
        'read',
      );
      if (
        workflow?.exposure?.revision !== run.revision ||
        workflow.versionId !== run.versionId
      )
        throw new McpToolUnavailableError();
      if (run.status === 'succeeded' && run.result?.kind === 'inline')
        return { status: 'completed' as const, result: run.result.value };
      if (TERMINAL_RUN_STATUSES.has(run.status))
        return { status: 'failed' as const };
      return { status: 'pending' as const, invocation: input.invocation };
    },
  );
}
