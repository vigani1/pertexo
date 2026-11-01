import type { Pool } from 'pg';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { cancelWorkflowTest } from './cancel.js';
import type {
  WorkflowTestCommand,
  WorkflowTestPreparation,
  WorkflowTestRunInput,
} from './contract.js';
import { loadTestSnapshot } from './snapshot.repository.js';
import { startWorkflowTest } from './start.js';
import { withTestChange, withTestRead } from './access.js';
import { readTestDetail, listTests } from './records.queries.js';

export type WorkflowTestStore = ReturnType<typeof createWorkflowTestStore>;

export function createWorkflowTestStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
) {
  return {
    prepare: (input: SampleScope): Promise<WorkflowTestPreparation> =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await loadTestSnapshot(client, input, catalogs)).preparation,
      ),
    start: (input: WorkflowTestCommand) =>
      withTestChange(pool, input, (client, role) =>
        startWorkflowTest(client, role, input, catalogs),
      ),
    list: (input: SampleScope) =>
      withTestRead(pool, input, (client) => listTests(client, input)),
    get: (input: WorkflowTestRunInput) =>
      withTestRead(pool, input, (client) => readTestDetail(client, input)),
    cancel: (input: WorkflowTestRunInput) =>
      withTestChange(pool, input, (client, role) =>
        cancelWorkflowTest(client, role, input),
      ),
  };
}
