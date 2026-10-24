import { bindResourcePredicate } from '../../../tenant-access/resources/query-scope.js';
import { RUN_DETAILS_RETENTION_SQL } from '../../../runs/data-policy.js';
import type { Pool } from 'pg';
import type { NodeWebhookResponse } from '@pertexo/node-sdk';
import { withTenantScopedReadClient } from '../../../tenant-access/transactions.js';
import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from './contract.js';

type ResponseRow = Readonly<{
  status: string;
  status_code: number | null;
  content_type: NodeWebhookResponse['contentType'] | null;
  headers: NodeWebhookResponse['headers'] | null;
  body: string | null;
}>;
export function readWebhookResponse(
  pool: Pool,
  input: WebhookResponseScope,
): Promise<WebhookResponseSnapshot> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.workspaceId },
    async (client) => {
      const result = await client.query<ResponseRow>(
        `select run.status,response.status_code,response.content_type,response.headers,response.body
      from app.webhook_run_responses response join app.workflow_runs run on run.workspace_id=response.workspace_id and run.id=response.run_id
      where response.workspace_id=$1 and response.run_id=$2 and run.details_purged_at IS NULL
        and (run.completed_at IS NULL or run.completed_at>clock_timestamp()-${bindResourcePredicate(RUN_DETAILS_RETENTION_SQL.inlineParams(), [])})`,
        [input.workspaceId, input.runId],
      );
      const row = result.rows[0];
      if (row === undefined) return { state: 'finished' };
      const responseAvailable =
        row.status_code !== null &&
        row.content_type !== null &&
        row.headers !== null &&
        row.body !== null;
      if (responseAvailable)
        return {
          state: 'responded',
          response: {
            statusCode: row.status_code,
            contentType: row.content_type,
            headers: row.headers,
            body: row.body,
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
