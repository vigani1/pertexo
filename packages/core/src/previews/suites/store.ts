import type { Pool } from 'pg';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import { withTestChange, withTestRead } from '../workflows/access.js';
import { cancelTestSuite } from './cancel.js';
import type { WorkflowTestSuiteStore } from './contract.js';
import { readSuiteCurrent } from './current.queries.js';
import { listSuites, readCaseReport, readSuite } from './records.queries.js';
import { prepareTestSuite, startTestSuite } from './start.js';

export function createWorkflowTestSuiteStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestSuiteStore {
  return {
    prepare: (input) =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await prepareTestSuite(client, input, catalogs)).prepared,
      ),
    start: (input) =>
      withTestChange(pool, input, (client, role) =>
        startTestSuite(client, role, input, catalogs),
      ),
    list: (input) =>
      withTestRead(pool, input, async (client) => ({
        current: await readSuiteCurrent(client, input),
        items: await listSuites(client, input),
      })),
    get: (input) =>
      withTestRead(pool, input, (client) => readSuite(client, input)),
    report: (input) =>
      withTestRead(pool, input, (client) => readCaseReport(client, input)),
    cancel: (input) =>
      withTestChange(pool, input, (client, role) =>
        cancelTestSuite(client, role, input),
      ),
  };
}
