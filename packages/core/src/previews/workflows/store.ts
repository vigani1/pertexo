import type { Pool, PoolClient } from 'pg';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { cancelWorkflowTest } from './cancel.js';
import type { WorkflowTestStore } from './contract.js';
import { loadTestSnapshot } from './snapshot.repository.js';
import { startWorkflowTest } from './start.js';
import { withTestAuthority, withTestRead } from './access.js';
import { readTestDetail, listTests } from './records.queries.js';

export function createWorkflowTestStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestStore {
  const transact = <T>(
    input: SampleScope,
    work: (client: PoolClient) => Promise<T>,
  ) => withTestAuthority(pool, input, work);
  return {
    prepare: (input) =>
      transact(
        input,
        async (client) =>
          (await loadTestSnapshot(client, input, catalogs)).preparation,
      ),
    start: (input) =>
      transact(input, (client) => startWorkflowTest(client, input, catalogs)),
    list: (input) =>
      withTestRead(pool, input, (client) => listTests(client, input)),
    get: (input) =>
      withTestRead(pool, input, (client) => readTestDetail(client, input)),
    cancel: (input) =>
      transact(input, (client) => cancelWorkflowTest(client, input)),
  };
}
