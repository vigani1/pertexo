import { generatePersistedId } from '../../../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../command-receipts.js';
import {
  WorkflowNameRevisionConflictError,
  WorkflowNotFoundError,
} from '../errors.js';
import type {
  RenameWorkflowInput,
  RenameWorkflowResult,
  WorkflowAuthoringDatabase,
} from '../contracts.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import type { WorkflowRecord } from '../representation/records.js';
import { mapWorkflow, workflowRowSelection } from '../representation/rows.js';

const uuidSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(128);
const nameRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const requestIdSchema = z.string().max(128);

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
    workspaceId: uuidSchema.parse(input.workspaceId),
    workflowId: uuidSchema.parse(input.workflowId),
    actorId: uuidSchema.parse(input.actorId),
    name: nameSchema.parse(input.name),
    expectedNameRevision: nameRevisionSchema.parse(input.expectedNameRevision),
    requestId:
      input.requestId === undefined
        ? null
        : requestIdSchema.parse(input.requestId),
    traceId:
      input.traceId === undefined ? null : requestIdSchema.parse(input.traceId),
  });
}

/** Locks the active workflow; an archived workflow is read-only, like its draft. */
async function lockActiveWorkflow(
  client: PoolClient,
  command: RenameCommand,
): Promise<WorkflowRecord> {
  const locked = await client.query<Record<string, unknown>>(
    `select ${workflowRowSelection} from app.workflows
     where workspace_id=$1 and id=$2 and lifecycle_status='active'
     for update`,
    [command.workspaceId, command.workflowId],
  );
  const row = locked.rows[0];
  if (row === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const current = mapWorkflow(row);
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
  const updated = await client.query<Record<string, unknown>>(
    `update app.workflows set name=$3,name_revision=name_revision+1,
       updated_at=transaction_timestamp()
     where workspace_id=$1 and id=$2 and name_revision=$4
       and lifecycle_status='active'
     returning ${workflowRowSelection}`,
    [
      command.workspaceId,
      command.workflowId,
      command.name,
      command.expectedNameRevision,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined)
    throw new WorkflowNameRevisionConflictError(current.nameRevision);
  const renamed = mapWorkflow(row);
  await client.query(
    `insert into app.audit_events
       (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
        trace_id,metadata)
     values($1,$2,$3,'workflow.renamed','workflow',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      command.workspaceId,
      command.actorId,
      command.workflowId,
      command.requestId,
      command.traceId,
      JSON.stringify({
        fromName: current.name,
        toName: renamed.name,
        fromNameRevision: current.nameRevision,
        toNameRevision: renamed.nameRevision,
      }),
    ],
  );
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
      await context.requireAuthor(client, command.workspaceId, command.actorId);
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
