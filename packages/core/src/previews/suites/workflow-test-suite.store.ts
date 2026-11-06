import type { WorkflowActor } from '../../shared/workflow-actor.js';
import type { Pool } from 'pg';
import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';

import type { WorkflowTestOptions } from '../workflows/workflow-test.types.js';
import { withTestChange, withTestRead } from '../workflows/access.js';
import { cancelTestSuite } from './cancel.js';
import type {
  WorkflowTestSuiteCaseInput,
  WorkflowTestSuiteInput,
  WorkflowTestSuiteStartInput,
} from './workflow-test-suite.types.js';
import { readSuiteCurrent } from './current.repository.js';
import {
  listSuites,
  readCaseReport,
  readSuite,
} from './test-suites.repository.js';
import { prepareTestSuite, startTestSuite } from './start.js';

export type WorkflowTestSuiteStore = ReturnType<
  typeof createWorkflowTestSuiteStore
>;

export function createWorkflowTestSuiteStore(
  pool: Pool,
  options: WorkflowTestOptions,
) {
  return {
    prepare: (input: WorkflowActor): Promise<WorkflowTestSuitePreparation> =>
      withTestChange(
        pool,
        input,
        async (client) =>
          (await prepareTestSuite(client, input, options)).prepared,
      ),
    start: (input: WorkflowTestSuiteStartInput) =>
      withTestChange(pool, input, (client, role) =>
        startTestSuite(client, role, input, options),
      ),
    list: (input: WorkflowActor) =>
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
