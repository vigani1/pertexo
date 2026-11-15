import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  DEFAULT_TEST_EXPECTATIONS,
  workflowTestExpectationsSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type {
  CaseTransaction,
  GetInputCaseInput,
  InputCaseDetail,
  InputCasePage,
  ListInputCasesInput,
} from './workflow-input-case.types.js';
import { requireCaseWorkflow } from './require-case-workflow.js';
import { readCasePage, readCaseDetail } from './read.repository.js';

export function listInputCases(
  transact: CaseTransaction,
  input: ListInputCasesInput,
): Promise<InputCasePage> {
  return transact(input, {
    write: false,
    work: async (client) => {
      const limit = input.limit;
      await requireCaseWorkflow(client, input, { write: false });
      const rows = await readCasePage(client, input, limit);
      const items = rows.slice(0, limit).map((row) => Object.freeze(row));
      const last = items.at(-1);
      return {
        items,
        ...(rows.length > limit && last
          ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
          : {}),
      };
    },
  });
}

export function getInputCase(
  transact: CaseTransaction,
  input: GetInputCaseInput,
): Promise<InputCaseDetail> {
  return transact(input, {
    write: false,
    work: async (client) => {
      await requireCaseWorkflow(client, input, { write: false });
      const row = await readCaseDetail(client, input);
      if (!row)
        throw new WorkflowNotFoundError('Run-input case is not visible');
      const expectations = row.expectations;
      return {
        case: {
          ...Object.freeze(row.metadata),
          expectations:
            expectations === null
              ? DEFAULT_TEST_EXPECTATIONS
              : decodeStoredValue(() =>
                  workflowTestExpectationsSchema.parse(
                    JSON.parse(expectations),
                  ),
                ),
          input: decodeStoredValue(() => z.json().parse(JSON.parse(row.input))),
        },
      };
    },
  });
}
