import type { Pool } from 'pg';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { credentialCommandScope } from '@pertexo/database/platform';
import {
  commandKeyHash,
  commandRequestHash,
} from '../../shared/command-fingerprints.js';
import type { WorkspaceActor } from '../../shared/access/workspace-access.js';
import { withRunCommand } from '../access.js';
import { lockRunAcceptanceCommand } from '../commands/acceptance/lock.repository.js';
import { acceptWorkflowRunWithAudit } from '../commands/accept-with-audit.js';
import { createInitialCheckpoint } from '../commands/create-initial-checkpoint.js';
import { findPublishedWorkflow } from '../queries/execution/published.repository.js';
import type { PersistedWorkflowProjectionVerificationOptions } from '../queries/execution/verify-projection.js';
import {
  activeExposure,
  listMcpWorkflows,
  readMcpWorkflow,
} from './exposure.repository.js';
import { McpToolUnavailableError } from './mcp.errors.js';

export type McpCaller = WorkspaceActor & Readonly<{ tokenId: string }>;

function invocationReference(runId: string, tokenId: string): string {
  return Buffer.from(
    `${runId}.${commandRequestHash({ runId, tokenId })}`,
  ).toString('base64url');
}

export function invokeMcpTool(
  pool: Pool,
  verification: PersistedWorkflowProjectionVerificationOptions,
  input: McpCaller &
    Readonly<{
      name: string;
      arguments: Record<string, unknown>;
      key?: string | undefined;
      requestId?: string | undefined;
      traceId?: string | undefined;
    }>,
) {
  return withRunCommand(
    pool,
    input,
    {
      capability: 'run:start',
      statuses: ACTIVE_WORKSPACE_STATUSES,
    },
    async (transaction) => {
      const scope = credentialCommandScope(`mcp:${input.name}`, input.tokenId);
      const keyHash = commandKeyHash(input.key);
      await lockRunAcceptanceCommand(transaction, {
        scope,
        idempotencyKeyHash: keyHash,
      });
      const [candidate] = await listMcpWorkflows(transaction, {
        name: input.name,
      });
      if (candidate === undefined) throw new McpToolUnavailableError();
      const workflow = await readMcpWorkflow(
        transaction,
        candidate.id,
        'invoke',
      );
      const exposure =
        workflow === undefined ? undefined : activeExposure(workflow);
      if (exposure?.name !== input.name || workflow?.pause !== 'none')
        throw new McpToolUnavailableError();
      const version = await findPublishedWorkflow(transaction.db, {
        workspaceId: input.workspaceId,
        workflowId: candidate.id,
        id: exposure.versionId,
      });
      if (version === null) throw new McpToolUnavailableError();
      const initial = createInitialCheckpoint(version, verification);
      const { run } = await acceptWorkflowRunWithAudit(transaction, {
        acceptance: {
          operation: 'workflow.run.accept',
          keyHash,
          scope,
          requestHash: commandRequestHash({
            workflowId: candidate.id,
            versionId: version.id,
            exposureRevision: exposure.revision,
            arguments: input.arguments,
          }),
          workflowId: candidate.id,
          workflowVersionId: version.id,
          triggerType: 'manual',
          runInput: input.arguments,
          initialCheckpoint: initial.checkpoint,
          validateInput: initial.validateInput,
          mcpInvocation: (runId) => ({
            tokenId: input.tokenId,
            exposureRevision: exposure.revision,
            referenceDigest: commandKeyHash(
              invocationReference(runId, input.tokenId),
            ),
          }),
        },
        actorId: input.actorId,
        auditAction: 'workflow.mcp.invoked',
        auditMetadata: {
          workflowId: candidate.id,
          workflowVersionId: version.id,
          toolName: exposure.name,
          tokenId: input.tokenId,
        },
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
      return {
        runId: run.id,
        invocation: invocationReference(run.id, input.tokenId),
      };
    },
  );
}
