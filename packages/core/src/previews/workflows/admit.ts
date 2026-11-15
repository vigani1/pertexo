import type { WorkflowActor } from '../../shared/workflow-actor.js';
import { databaseSchema } from '@pertexo/database/schema';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../../runs/commands/acceptance/accept.js';
import { WorkflowTestError } from './workflow-test.errors.js';
import { hasActiveTestRun } from './workflow-tests.repository.js';
import { hasRunningSuite } from '../suites/suite-state.repository.js';

export async function requireNoActiveTest(
  client: PoolClient,
  input: WorkflowActor,
): Promise<void> {
  if (await hasActiveTestRun(client, input))
    throw new WorkflowTestError('already_running');
}
export async function requireNoActiveSuite(
  client: PoolClient,
  input: WorkflowActor,
): Promise<void> {
  if (await hasRunningSuite(client, input))
    throw new WorkflowTestError('already_running');
}
/** Every suite case is an ordinary draft test, with one acceptance/outbox owner. */
export async function admitTestRun(
  client: PoolClient,
  input: WorkflowActor &
    Readonly<{
      runId: string;
      snapshotId: string;
      input: unknown;
      initialCheckpoint: unknown;
      deadlineAt: Date;
      command: Readonly<{ scope: string; key: string; request: unknown }>;
      variableSetRevision?: number | null;
    }>,
) {
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const preparation = await prepareWorkflowRunAcceptance(
    transaction,
    input.workflowId,
  );
  const digest = (text: string) =>
    createHash('sha256').update(text).digest('hex');
  return acceptWorkflowRun(
    transaction,
    {
      operation: 'workflow.run.accept',
      scope: input.command.scope,
      keyHash: digest(input.command.key),
      requestHash: digest(canonicalJson(input.command.request)),
      workflowId: input.workflowId,
      workflowVersionId: input.snapshotId,
      startedBy: input.actorId,
      triggerType: 'test',
      runInput: input.input,
      initialCheckpoint: input.initialCheckpoint,
      deadlineAt: input.deadlineAt,
    },
    {
      ...preparation,
      runId: input.runId,
      failureNotificationPolicy: undefined,
      ...(input.variableSetRevision === undefined
        ? {}
        : { variableSetRevision: input.variableSetRevision }),
    },
  );
}
