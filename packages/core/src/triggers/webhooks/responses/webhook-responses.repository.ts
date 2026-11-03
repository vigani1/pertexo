import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  webhookRunResponses as responses,
  workflowRuns,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  withTenantScopedReadClient,
} from '@pertexo/database/primitives';
import { RUN_DETAILS_RETENTION_SQL } from '../../../runs/data-policy.js';
import type { Pool } from 'pg';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from './contract.js';

export function readWebhookResponse(
  pool: Pool,
  input: WebhookResponseScope,
): Promise<WebhookResponseSnapshot> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const result = await drizzle(client)
        .select({
          status: workflowRuns.status,
          status_code: responses.statusCode,
          content_type: responses.contentType,
          headers: responses.headers,
          body: responses.body,
        })
        .from(responses)
        .innerJoin(
          workflowRuns,
          and(
            eq(workflowRuns.workspaceId, responses.workspaceId),
            eq(workflowRuns.id, responses.runId),
          ),
        )
        .where(
          and(
            eq(responses.workspaceId, input.workspaceId),
            eq(responses.runId, input.runId),
            isNull(workflowRuns.detailsPurgedAt),
            or(
              isNull(workflowRuns.completedAt),
              sql`${workflowRuns.completedAt}>clock_timestamp()-${RUN_DETAILS_RETENTION_SQL}`,
            ),
          ),
        )
        .catch(rethrowQueryFailure);
      const row = result[0];
      if (row === undefined) return { state: 'finished' };
      const {
        status_code: statusCode,
        content_type: contentType,
        headers,
        body,
      } = row;
      const responseAvailable =
        statusCode !== null &&
        contentType !== null &&
        headers !== null &&
        body !== null;
      if (responseAvailable)
        return {
          state: 'responded',
          response: {
            statusCode,
            contentType,
            headers,
            body,
          },
        };
      if (['failed', 'timed_out', 'outcome_unknown'].includes(row.status))
        return { state: 'failed' };
      return {
        state: ['succeeded', 'canceled'].includes(row.status)
          ? 'finished'
          : 'pending',
      };
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
