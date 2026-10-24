import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowInputCases,
  workflowInputCasePayloads,
} from '../../schema/authoring/input-cases.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { z } from 'zod';
import {
  DEFAULT_TEST_EXPECTATIONS,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';

import { WorkflowNotFoundError } from '../workflows/errors.js';
import type { WorkflowInputCaseDatabase, CaseTransaction } from './contract.js';
import { metadataProjection, workflow } from './metadata.queries.js';

export function listInputCases(
  transact: CaseTransaction,
  input: Parameters<WorkflowInputCaseDatabase['listCases']>[0],
): ReturnType<WorkflowInputCaseDatabase['listCases']> {
  return transact(input, {
    write: false,
    work: async (client) => {
      const limit = z.number().int().min(1).max(100).parse(input.limit);
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
  input: Parameters<WorkflowInputCaseDatabase['getCase']>[0],
): ReturnType<WorkflowInputCaseDatabase['getCase']> {
  return transact(input, {
    write: false,
    work: async (client) => {
      z.uuid().parse(input.caseId);
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
      return {
        case: {
          ...Object.freeze(row.metadata),
          expectations:
            row.expectations === null
              ? DEFAULT_TEST_EXPECTATIONS
              : (JSON.parse(row.expectations) as WorkflowTestExpectations),
          input: JSON.parse(row.input) as unknown,
        },
      };
    },
  });
}
