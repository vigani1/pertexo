import type { Pool } from 'pg';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import { cancelWorkflowTest } from './cancel.js';
import type { WorkflowTestStore } from './contract.js';
import { loadTestSnapshot } from './snapshot.repository.js';
import { startWorkflowTest } from './start.js';
import { withTestChange, withTestRead } from './access.js';
import { readTestDetail, listTests } from './records.queries.js';

export function createWorkflowTestStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestStore {
  return {
    prepare: (input) =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await loadTestSnapshot(client, input, catalogs)).preparation,
      ),
    start: (input) =>
      withTestChange(pool, input, (client, role) =>
        startWorkflowTest(client, role, input, catalogs),
      ),
    list: (input) =>
      withTestRead(pool, input, (client) => listTests(client, input)),
    get: (input) =>
      withTestRead(pool, input, (client) => readTestDetail(client, input)),
    cancel: (input) =>
      withTestChange(pool, input, (client, role) =>
        cancelWorkflowTest(client, role, input),
      ),
  };
}
