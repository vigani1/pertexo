import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model';

import {
  claimCommand,
  completeCommand,
  type CommandIdentity,
} from '../../platform/idempotency.js';
import type { WorkflowRecord } from './representation/records.js';

const uuidSchema = z.uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The accepted workflow summary an exact command retry replays. */
const storedResultSchema = z
  .object({
    workflow: z
      .object({
        id: uuidSchema,
        workspaceId: uuidSchema,
        name: z.string().trim().min(1).max(128),
        nameRevision: revisionSchema,
        lifecycleStatus: workflowLifecycleStatusSchema,
        lifecycleRevision: revisionSchema,
        activationStatus: workflowActivationStatusSchema,
        publishedVersionId: uuidSchema.nullable(),
        createdBy: uuidSchema,
        createdAt: z.coerce.date(),
        updatedAt: z.coerce.date(),
      })
      .strict(),
  })
  .strict();

/** A command on one workflow, keyed per actor and workflow. */
export type WorkflowCommand = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  operation: `workflow.${string}`;
  idempotencyKey: string;
  request: unknown;
}>;

function identity(command: WorkflowCommand): CommandIdentity {
  return {
    workspaceId: command.workspaceId,
    operation: command.operation,
    scope: `${command.actorId}:${command.workflowId}`,
    idempotencyKey: command.idempotencyKey,
  };
}

/** Claims the command's key; returns the workflow an exact retry replays. */
export async function claimWorkflowCommand(
  client: PoolClient,
  command: WorkflowCommand,
): Promise<WorkflowRecord | null> {
  const stored = await claimCommand(client, {
    ...identity(command),
    request: command.request,
    resourceId: command.workflowId,
  });
  if (stored === null) return null;
  const { workflow } = storedResultSchema.parse(stored);
  if (
    workflow.workspaceId !== command.workspaceId ||
    workflow.id !== command.workflowId
  )
    throw new Error('Stored workflow command result names another workflow');
  return Object.freeze({ ...workflow });
}

/** Stores the accepted workflow so an exact retry replays it unchanged. */
export async function completeWorkflowCommand(
  client: PoolClient,
  command: WorkflowCommand,
  workflow: WorkflowRecord,
): Promise<void> {
  await completeCommand(client, identity(command), {
    workflow: {
      id: workflow.id,
      workspaceId: workflow.workspaceId,
      name: workflow.name,
      nameRevision: workflow.nameRevision,
      lifecycleStatus: workflow.lifecycleStatus,
      lifecycleRevision: workflow.lifecycleRevision,
      activationStatus: workflow.activationStatus,
      publishedVersionId: workflow.publishedVersionId,
      createdBy: workflow.createdBy,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    },
  });
}
