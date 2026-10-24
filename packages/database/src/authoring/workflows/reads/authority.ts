import { workflowAccessible } from '../../../tenant-access/resources/workflows.queries.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { WorkflowAuthoringReadContext } from './contract.js';

export const uuidSchema = z.uuid();

export async function canReadWorkflow(
  context: WorkflowAuthoringReadContext,
  client: PoolClient,
  {
    workspaceId,
    actorId,
    workflowId,
  }: Readonly<{ workspaceId: string; actorId: string; workflowId: string }>,
) {
  const access = await context.requireReader(client, workspaceId, actorId);
  return workflowAccessible(client, access, {
    workspaceId,
    workflowId,
  });
}
