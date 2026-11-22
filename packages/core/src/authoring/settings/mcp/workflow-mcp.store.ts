import type { Pool } from 'pg';
import {
  ACTIVE_WORKSPACE_STATUSES,
  isAdministrativeRole,
} from '@pertexo/policy';
import { generatePersistedId } from '@pertexo/database/platform';
import type { WorkflowMcpExposureRequest } from '@pertexo/contracts';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import { readResourceTransaction } from '../../../shared/access/folder-access-facts.repository.js';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../../shared/access/workspace-access.js';
import { readMcpWorkflow } from '../../../runs/mcp/exposure.repository.js';
import { callableTool } from '../../../runs/mcp/callable-tool.js';
import { findPublishedWorkflow } from '../../../runs/queries/execution/published.repository.js';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import { mcpToolNameInUse, writeMcpExposure } from './exposure.repository.js';
import { McpExposureConflictError } from './mcp-exposure.errors.js';

type WorkflowCaller = WorkspaceActor & Readonly<{ workflowId: string }>;

export function createWorkflowMcpStore(pool: Pool, catalog: unknown) {
  return Object.freeze({
    read: (input: WorkflowCaller) =>
      withMcpSettings(pool, input, 'read', async (transaction, workflow) => {
        const version = await findPublishedWorkflow(transaction.db, {
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          id: workflow.versionId,
        });
        return {
          publishedVersionId: workflow.versionId,
          eligible:
            workflow.lifecycle === 'active' &&
            version !== null &&
            callableTool(version, { catalog }) !== undefined,
          exposure: workflow.exposure,
        };
      }),
    update: (
      input: WorkflowCaller & {
        request: WorkflowMcpExposureRequest;
        requestId?: string | undefined;
        traceId?: string | undefined;
      },
    ) =>
      withMcpSettings(
        pool,
        input,
        'exclusive',
        async (transaction, workflow) => {
          const { request } = input;
          if (
            request.expectedVersionId !== workflow.versionId ||
            request.expectedRevision !== (workflow.exposure?.revision ?? null)
          )
            throw new McpExposureConflictError('version_changed');
          let exposure = null;
          if (request.kind === 'expose') {
            const version = await findPublishedWorkflow(transaction.db, {
              workspaceId: input.workspaceId,
              workflowId: input.workflowId,
              id: workflow.versionId,
            });
            const tool =
              version === null ? undefined : callableTool(version, { catalog });
            if (
              tool === undefined ||
              version === null ||
              workflow.lifecycle !== 'active'
            )
              throw new McpExposureConflictError('entry_unavailable');
            if (
              await mcpToolNameInUse(
                transaction,
                input.workflowId,
                request.name,
              )
            )
              throw new McpExposureConflictError('name_in_use');
            exposure = {
              versionId: version.id,
              entryId: tool.entryId,
              revision: generatePersistedId(),
              name: request.name,
              description: request.description,
            };
          }
          if (exposure !== null || workflow.exposure !== null) {
            await writeMcpExposure(transaction, input.workflowId, exposure);
            const previous = workflow.exposure;
            await appendAuditFact(transaction, {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              targetType: 'workflow',
              targetId: input.workflowId,
              action:
                exposure === null
                  ? 'workflow.mcp.unexposed'
                  : 'workflow.mcp.exposed',
              requestId: input.requestId ?? null,
              traceId: input.traceId ?? null,
              metadata: {
                toolName: (exposure ?? previous)?.name,
                workflowVersionId: (exposure ?? previous)?.versionId,
              },
            });
          }
          return { exposure };
        },
      ),
  });
}

async function withMcpSettings<T>(
  pool: Pool,
  input: WorkflowCaller,
  mode: 'read' | 'exclusive',
  operation: (
    transaction: Awaited<ReturnType<typeof readResourceTransaction>>,
    workflow: NonNullable<Awaited<ReturnType<typeof readMcpWorkflow>>>,
  ) => Promise<T>,
) {
  return withWorkspaceAccess(
    pool,
    input,
    {
      capability: 'workflow:publish',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      mode,
    },
    async (client, role) => {
      if (!isAdministrativeRole(role))
        throw new WorkflowNotFoundError('Workflow not found');
      const transaction = await readResourceTransaction(client, input, role);
      const workflow = await readMcpWorkflow(
        transaction,
        input.workflowId,
        mode === 'read' ? 'settings' : 'manage',
      );
      if (workflow === undefined)
        throw new WorkflowNotFoundError('Workflow not found');
      return operation(transaction, workflow);
    },
  );
}
