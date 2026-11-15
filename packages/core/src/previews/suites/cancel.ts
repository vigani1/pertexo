import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { parseWorkspaceId } from '@pertexo/database/primitives';
import { databaseSchema } from '@pertexo/database/schema';
import type { Role } from '@pertexo/policy';
import { cancelInTransaction } from '../../runs/commands/cancel-run.js';
import { WorkflowRunNotFoundError } from '../../runs/workflow-run.errors.js';
import { requireTestStopAuthority } from '../workflows/access.js';
import { WorkflowTestError } from '../workflows/workflow-test.errors.js';
import { readRunningCaseRunId, skipPendingCases } from './cases.repository.js';
import {
  completeSuite,
  lockLiveSuite,
  requestSuiteCancel,
} from './suite-state.repository.js';
import type { WorkflowTestSuiteInput } from './workflow-test-suite.types.js';

export async function cancelTestSuite(
  client: PoolClient,
  role: Role,
  input: WorkflowTestSuiteInput,
): Promise<void> {
  const suite = await lockLiveSuite(client, input);
  if (suite === undefined) throw new WorkflowTestError('not_found');
  requireTestStopAuthority(role, suite.startedBy, input.actorId);
  if (suite.status !== 'running') return;
  const key = { workspaceId: input.workspaceId, id: input.suiteId };
  await requestSuiteCancel(client, key);
  await skipPendingCases(client, input.workspaceId, input.suiteId);
  const runId = await readRunningCaseRunId(client, input);
  if (runId === undefined) await completeSuite(client, key, 'canceled');
  else if (runId === null) throw new WorkflowRunNotFoundError();
  else
    await cancelInTransaction(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(input.workspaceId),
      },
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        runId,
      },
    );
}
