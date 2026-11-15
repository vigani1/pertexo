import type { PoolClient } from 'pg';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowInputCasePayloads,
  workflowInputCases,
} from '@pertexo/database/schema';
import type {
  GetInputCaseInput,
  ListInputCasesInput,
} from './workflow-input-case.types.js';
import { metadataProjection } from './metadata.repository.js';

/** Cases in creation order after the cursor, one past `limit` so a next page shows. */
export async function readCasePage(
  client: PoolClient,
  input: ListInputCasesInput,
  limit: number,
) {
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
  return rows;
}

export async function readCaseDetail(
  client: PoolClient,
  input: GetInputCaseInput,
) {
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
  return row;
}
