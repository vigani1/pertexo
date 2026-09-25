import { generatePersistedId } from '../platform/persisted-id.js';

import { canonicalOutboxPayloadChecksum } from '../execution/outbox.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  claimWorkflowCommand,
  completeWorkflowCommand,
} from './workflow-authoring-command-receipts.js';
import {
  WorkflowNameRevisionConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';
import type {
  RenameWorkflowInput,
  RenameWorkflowResult,
  WorkflowAuthoringDatabase,
} from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringLifecycleContext } from './workflow-authoring-lifecycle.js';
import type { WorkflowRecord } from './workflow-authoring-records.js';
import { workflowRowSelection } from './workflow-authoring-rows.js';

const uuidSchema = z.uuid();
const nameSchema = z.string().trim().min(1).max(128);
const nameRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const requestIdSchema = z.string().max(128);

type WorkflowRenameStore = Pick<WorkflowAuthoringDatabase, 'renameWorkflow'>;

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
  context: WorkflowAuthoringLifecycleContext,
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
  const current = context.mapWorkflow(row);
  if (current.nameRevision !== command.expectedNameRevision)
    throw new WorkflowNameRevisionConflictError(current.nameRevision);
  return current;
}

async function applyRename(
  client: PoolClient,
  context: WorkflowAuthoringLifecycleContext,
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
  const renamed = context.mapWorkflow(row);
  await context.testHooks?.afterRenameStep?.('workflow');
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
  await context.testHooks?.afterRenameStep?.('audit');
  return renamed;
}

/**
 * ADR 041: renames at the expected name revision. An exact retry replays the
 * original summary; the same name at the current revision changes nothing.
 */
async function renameWorkflow(
  context: WorkflowAuthoringLifecycleContext,
  input: RenameWorkflowInput,
): Promise<RenameWorkflowResult> {
  const command = parseRenameCommand(input);
  return context.transact(
    command.workspaceId,
    command.actorId,
    async (client) => {
      await context.requireAuthor(client, command.workspaceId, command.actorId);
      const claim = await claimWorkflowCommand(client, {
        label: 'rename',
        operation: 'workflow.rename',
        digest: context.keyDigest(input.idempotencyKey),
        requestHash: canonicalOutboxPayloadChecksum({
          actorId: command.actorId,
          command: 'rename',
          expectedNameRevision: command.expectedNameRevision,
          name: command.name,
          workflowId: command.workflowId,
          workspaceId: command.workspaceId,
        }),
        workflowId: command.workflowId,
        workspaceId: command.workspaceId,
        actorId: command.actorId,
      });
      await context.testHooks?.afterRenameStep?.('claim');
      if (claim.replay !== null)
        return Object.freeze({ replayed: true, workflow: claim.replay });

      const current = await lockActiveWorkflow(client, context, command);
      const workflow =
        current.name === command.name
          ? current
          : await applyRename(client, context, command, current);
      await completeWorkflowCommand(client, claim, workflow);
      await context.testHooks?.afterRenameStep?.('idempotency');
      return Object.freeze({ replayed: false, workflow });
    },
  );
}

export function createWorkflowAuthoringRenameStore(
  context: WorkflowAuthoringLifecycleContext,
): WorkflowRenameStore {
  return Object.freeze({
    renameWorkflow: (input) => renameWorkflow(context, input),
  });
}
