import type { Pool } from 'pg';
import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import { withTestChange, withTestRead } from '../workflows/access.js';
import { cancelTestSuite } from './cancel.js';
import type {
  WorkflowTestSuiteCaseInput,
  WorkflowTestSuiteInput,
  WorkflowTestSuiteStartInput,
} from './contract.js';
import { readSuiteCurrent } from './current.queries.js';
import { listSuites, readCaseReport, readSuite } from './records.queries.js';
import { prepareTestSuite, startTestSuite } from './start.js';

export type WorkflowTestSuiteStore = ReturnType<
  typeof createWorkflowTestSuiteStore
>;

export function createWorkflowTestSuiteStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
) {
  return {
    prepare: (input: SampleScope): Promise<WorkflowTestSuitePreparation> =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await prepareTestSuite(client, input, catalogs)).prepared,
      ),
    start: (input: WorkflowTestSuiteStartInput) =>
      withTestChange(pool, input, (client, role) =>
        startTestSuite(client, role, input, catalogs),
      ),
    list: (input: SampleScope) =>
      withTestRead(pool, input, async (client) => ({
        current: await readSuiteCurrent(client, input),
        items: await listSuites(client, input),
      })),
    get: (input: WorkflowTestSuiteInput) =>
      withTestRead(pool, input, (client) => readSuite(client, input)),
    report: (input: WorkflowTestSuiteCaseInput) =>
      withTestRead(pool, input, (client) => readCaseReport(client, input)),
    cancel: (input: WorkflowTestSuiteInput) =>
      withTestChange(pool, input, (client, role) =>
        cancelTestSuite(client, role, input),
      ),
  };
}
