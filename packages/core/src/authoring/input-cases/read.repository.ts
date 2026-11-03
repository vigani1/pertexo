import { decodeStoredValue } from '../../shared/stored-values.js';
import {
  DEFAULT_TEST_EXPECTATIONS,
  workflowTestExpectationsSchema,
} from '@pertexo/workflow-model';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
} from '@pertexo/database/schema';

import { WorkflowNotFoundError } from '../workflows/workflow-authoring.errors.js';
import type {
  CaseTransaction,
  GetInputCaseInput,
  InputCaseDetail,
  InputCasePage,
  ListInputCasesInput,
} from './workflow-input-case.types.js';
import { metadataProjection, workflow } from './metadata.repository.js';

export function listInputCases(
  transact: CaseTransaction,
  input: ListInputCasesInput,
): Promise<InputCasePage> {
  return transact(input, {
    write: false,
    work: async (client) => {
      const limit = input.limit;
      await workflow(client, input, { write: false });
      const rows = await drizzle(client)
        .select(metadataProjection)
        .from(workflowInputCases)
        .where(
          and(
            eq(workflowInputCases.workspaceId, input.workspaceId),
            eq(workflowInputCases.workflowId, input.workflowId),
            isNull(workflowInputCases.deletedAt),
            input.cursor === undefined
              ? undefined
              : sql`(${workflowInputCases.createdAt},${workflowInputCases.id})>(${input.cursor.createdAt}::timestamptz,${input.cursor.id}::uuid)`,
          ),
        )
        .orderBy(asc(workflowInputCases.createdAt), asc(workflowInputCases.id))
        .limit(limit + 1)
        .catch(rethrowQueryFailure);
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
      await workflow(client, input, { write: false });
      const [row] = await drizzle(client)
        .select({
          metadata: metadataProjection,
          input: workflowInputCasePayloads.input,
          expectations: workflowInputCasePayloads.expectations,
        })
        .from(workflowInputCases)
        .innerJoin(
          workflowInputCasePayloads,
          and(
            eq(
              workflowInputCasePayloads.workspaceId,
              workflowInputCases.workspaceId,
            ),
            eq(workflowInputCasePayloads.caseId, workflowInputCases.id),
            eq(workflowInputCasePayloads.revision, workflowInputCases.revision),
          ),
        )
        .where(
          and(
            eq(workflowInputCases.workspaceId, input.workspaceId),
            eq(workflowInputCases.workflowId, input.workflowId),
            eq(workflowInputCases.id, input.caseId),
            isNull(workflowInputCases.deletedAt),
          ),
        )
        .catch(rethrowQueryFailure);
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
