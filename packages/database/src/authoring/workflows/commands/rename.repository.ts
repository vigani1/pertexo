import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { workflows } from '../../../schema/authoring/workflows.js';

import type { PoolClient } from 'pg';

import type { WorkflowAuthoringWriteContext } from '../context.js';
import type {
  RenameWorkflowInput,
  RenameWorkflowResult,
  WorkflowAuthoringDatabase,
} from '../contract.js';
import {
  WorkflowNameRevisionConflictError,
  WorkflowNotFoundError,
} from '../errors.js';
import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../receipts.repository.js';
import type { WorkflowRecord } from '../representation/contract.js';
import { workflowProjection } from '../representation/records.queries.js';

type WorkflowRenameStore = Pick<WorkflowAuthoringDatabase, 'renameWorkflow'>;
type WorkflowRenameContext = Pick<
  WorkflowAuthoringWriteContext,
  'requireAuthor' | 'transact'
>;

type RenameCommand = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  name: string;
  expectedNameRevision: number;
  requestId: string | null;
  traceId: string | null;
}>;

function parseRenameCommand(input: RenameWorkflowInput): RenameCommand {
  return Object.freeze({
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    actorId: input.actorId,
    name: input.name,
    expectedNameRevision: input.expectedNameRevision,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
  });
}

/** Locks the active workflow; an archived workflow is read-only, like its draft. */
async function lockActiveWorkflow(
  client: PoolClient,
  command: RenameCommand,
): Promise<WorkflowRecord> {
  const [row] = await drizzle(client)
    .select(workflowProjection)
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, command.workspaceId),
        eq(workflows.id, command.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const current = Object.freeze(row);
  if (current.nameRevision !== command.expectedNameRevision)
    throw new WorkflowNameRevisionConflictError(current.nameRevision);
  return current;
}

async function applyRename(
  client: PoolClient,
  context: WorkflowRenameContext,
  command: RenameCommand,
  current: WorkflowRecord,
): Promise<WorkflowRecord> {
  const [row] = await drizzle(client)
    .update(workflows)
    .set({
      name: command.name,
      nameRevision: sql`${workflows.nameRevision}+1`,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflows.workspaceId, command.workspaceId),
        eq(workflows.id, command.workflowId),
        eq(workflows.nameRevision, command.expectedNameRevision),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .returning(workflowProjection)
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new WorkflowNameRevisionConflictError(current.nameRevision);
  const renamed = Object.freeze(row);
  await appendAuditFact(client, {
    workspaceId: command.workspaceId,
    actorId: command.actorId,
    action: 'workflow.renamed',
    targetType: 'workflow',
    targetId: command.workflowId,
    requestId: command.requestId,
    traceId: command.traceId,
    metadata: {
      fromName: current.name,
      toName: renamed.name,
      fromNameRevision: current.nameRevision,
      toNameRevision: renamed.nameRevision,
    },
  });
  return renamed;
}

/**
 * ADR 041: renames at the expected name revision. An exact retry replays the
 * original summary; the same name at the current revision changes nothing.
 */
async function renameWorkflow(
  context: WorkflowRenameContext,
  input: RenameWorkflowInput,
): Promise<RenameWorkflowResult> {
  const command = parseRenameCommand(input);
  return context.transact(
    command.workspaceId,
    command.actorId,
    async (client) => {
      await context.requireAuthor(client, command.workspaceId, {
        actorId: command.actorId,
        workflowId: command.workflowId,
      });
      const claim: WorkflowCommand = {
        workspaceId: command.workspaceId,
        workflowId: command.workflowId,
        actorId: command.actorId,
        operation: 'workflow.rename',
        idempotencyKey: input.idempotencyKey,
        request: {
          name: command.name,
          expectedNameRevision: command.expectedNameRevision,
        },
      };
      const replay = await claimWorkflowCommand(client, claim);
      if (replay !== null)
        return Object.freeze({ replayed: true, workflow: replay });

      const current = await lockActiveWorkflow(client, command);
      const workflow =
        current.name === command.name
          ? current
          : await applyRename(client, context, command, current);
      await completeWorkflowCommand(client, claim, workflow);
      return Object.freeze({ replayed: false, workflow });
    },
  );
}

export function createWorkflowAuthoringRenameStore(
  context: WorkflowRenameContext,
): WorkflowRenameStore {
  return Object.freeze({
    renameWorkflow: (input) => renameWorkflow(context, input),
  });
}
