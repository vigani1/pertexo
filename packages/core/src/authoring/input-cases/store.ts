import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { createAuthoringAccess } from '../workflows/access.js';
import type {
  CaseTransaction,
  CreateInputCaseInput,
  DeleteInputCaseInput,
  GetInputCaseInput,
  ListInputCasesInput,
  UpdateInputCaseInput,
} from './contract.js';

import {
  createInputCase,
  deleteInputCase,
  updateInputCase,
} from './commands/mutations.repository.js';
import { getInputCase, listInputCases } from './read.queries.js';

export type WorkflowInputCaseStore = ReturnType<
  typeof createWorkflowInputCaseStore
>;

/** Durable bounded authoring commands; no caller manages locks or quota counters. */
export function createWorkflowInputCaseStore(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
) {
  const lease = acquireDatabasePool(config, options.runtime);
  const access = createAuthoringAccess(lease.pool);
  const transact: CaseTransaction = (input, { write, work }) =>
    access.workflow(
      input,
      write
        ? { capability: 'workflow:update' }
        : {
            capability: 'workflow:read',
            statuses: BROWSABLE_WORKSPACE_STATUSES,
          },
      (client) => work(client),
    );
  let closing: Promise<void> | undefined;
  return Object.freeze({
    listCases: (input: ListInputCasesInput) => listInputCases(transact, input),
    getCase: (input: GetInputCaseInput) => getInputCase(transact, input),
    createCase: (input: CreateInputCaseInput) =>
      createInputCase(transact, input),
    updateCase: (input: UpdateInputCaseInput) =>
      updateInputCase(transact, input),
    deleteCase: (input: DeleteInputCaseInput) =>
      deleteInputCase(transact, input),
    close: () => {
      closing ??= access.drain().then(() => lease.close());
      return closing;
    },
  });
}
