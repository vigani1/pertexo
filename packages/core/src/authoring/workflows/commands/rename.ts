import { appendAuditFact } from '../../../governance/audit/facts.js';

import type { PoolClient } from 'pg';

import type {
  RenameWorkflowInput,
  RenameWorkflowResult,
} from '../workflow-commands.types.js';
import {
  WorkflowNameRevisionConflictError,
  WorkflowNotFoundError,
} from '../workflow-authoring.errors.js';
import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../receipts.repository.js';
import type { WorkflowRecord } from '../representation/workflow-record.types.js';
import { lockWorkflowRecord } from './locks.repository.js';
import { renameAtRevision } from './workflow-revisions.repository.js';

type RenameCommand = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  name: string;
  expectedNameRevision: number;
  requestId: string | null;
  traceId: string | null;
}>;

function renameCommandInput(input: RenameWorkflowInput): RenameCommand {
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
  const row = await lockWorkflowRecord(client, command, { active: true });
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const current = Object.freeze(row);
  if (current.nameRevision !== command.expectedNameRevision)
    throw new WorkflowNameRevisionConflictError(current.nameRevision);
  return current;
}

async function applyRename(
  client: PoolClient,
  command: RenameCommand,
  current: WorkflowRecord,
): Promise<WorkflowRecord> {
  const row = await renameAtRevision(client, command);
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
export async function renameWorkflow(
  client: PoolClient,
  input: RenameWorkflowInput,
): Promise<RenameWorkflowResult> {
  const command = renameCommandInput(input);
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
      : await applyRename(client, command, current);
  await completeWorkflowCommand(client, claim, workflow);
  return Object.freeze({ replayed: false, workflow });
}
