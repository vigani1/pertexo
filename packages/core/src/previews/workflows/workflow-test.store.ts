import type { WorkflowActor } from '../../shared/access/workflow-actor.types.js';
import type { Pool } from 'pg';
import type { WorkflowTestOptions } from './workflow-test.types.js';

import { cancelWorkflowTest } from './cancel.js';
import type {
  WorkflowTestCommand,
  WorkflowTestPreparation,
  WorkflowTestRunInput,
} from './workflow-test.types.js';
import { loadTestSnapshot } from './load-snapshot.js';
import { startWorkflowTest } from './start.js';
import { withTestChange, withTestRead } from './access.js';
import { listTests } from './workflow-tests.repository.js';
import { readTestDetail } from './read-test-detail.js';

export type WorkflowTestStore = ReturnType<typeof createWorkflowTestStore>;

export function createWorkflowTestStore(
  pool: Pool,
  options: WorkflowTestOptions,
) {
  return {
    prepare: (input: WorkflowActor): Promise<WorkflowTestPreparation> =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await loadTestSnapshot(client, input, options)).preparation,
      ),
    start: (input: WorkflowTestCommand) =>
      withTestChange(pool, input, (client, role) =>
        startWorkflowTest(client, role, input, options),
      ),
    list: (input: WorkflowActor) =>
      withTestRead(pool, input, (client) => listTests(client, input)),
    get: (input: WorkflowTestRunInput) =>
      withTestRead(pool, input, (client) => readTestDetail(client, input)),
    cancel: (input: WorkflowTestRunInput) =>
      withTestChange(pool, input, (client, role) =>
        cancelWorkflowTest(client, role, input),
      ),
  };
}
