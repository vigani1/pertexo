import { vi } from 'vitest';
import type { PoolClient } from 'pg';

import { withTenantScopedClient } from '@pertexo/core/testing';

import { workspaceId } from './environment.js';
import { apiPool, workerPool } from './lifecycle.js';

export async function waitFor<T>(
  poll: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMillis = 15_000,
): Promise<T> {
  const result = await vi.waitUntil(
    async () => {
      const value = await poll();
      return done(value) ? { value } : false;
    },
    { timeout: timeoutMillis, interval: 100 },
  );
  return result.value;
}

export function previewState(previewRunId: string) {
  return withTenantScopedWorker((client) =>
    client.query<{
      attempt_status: string;
      attempt_fence: string | number;
      dispatch_marked_at: Date | null;
      inbox_completed_count: string;
      inbox_count: string;
      lease_expired: boolean;
      output_ref: unknown;
      run_status: string;
      safe_error_code: string | null;
    }>(
      `select run.status as run_status,
              run.output_ref,
              run.safe_error_code,
              attempt.status as attempt_status,
              attempt.fence_token::text as attempt_fence,
              attempt.dispatch_marked_at,
              (attempt.lease_expires_at is null
                or attempt.lease_expires_at <= clock_timestamp())
                as lease_expired,
              (select count(*)::text from app.inbox_receipts receipt
                where receipt.workspace_id=run.workspace_id
                  and receipt.consumer_name='preview-attempt-worker'
                  and receipt.message_id=(
                    select event.id from app.outbox_events event
                     where event.workspace_id=run.workspace_id
                       and event.aggregate_id=run.id
                       and event.job_name='execute-preview-attempt'
                     order by event.created_at,event.id
                     limit 1)) as inbox_count,
              (select count(receipt.completed_at)::text
                 from app.inbox_receipts receipt
                where receipt.workspace_id=run.workspace_id
                  and receipt.consumer_name='preview-attempt-worker'
                  and receipt.message_id=(
                    select event.id from app.outbox_events event
                     where event.workspace_id=run.workspace_id
                       and event.aggregate_id=run.id
                       and event.job_name='execute-preview-attempt'
                     order by event.created_at,event.id
                     limit 1))
                as inbox_completed_count
       from app.preview_runs run
       join app.preview_attempts attempt
         on attempt.workspace_id = run.workspace_id
        and attempt.preview_run_id = run.id
       where run.workspace_id=$1 and run.id=$2`,
      [workspaceId, previewRunId],
    ),
  ).then((result) => result.rows[0]);
}

export function previewTerminalFacts(previewRunId: string) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<{ audit_count: string; usage_count: string }>(
      `select
         (select count(*)::text from app.audit_events audit
           where audit.workspace_id=$1
             and audit.action='preview.execution_terminal'
             and audit.target_type='preview-run'
             and audit.target_id=$2) as audit_count,
         (select count(*)::text from app.usage_events usage
           where usage.workspace_id=$1
             and usage.category='preview_execution'
             and usage.resource_type='preview-run'
             and usage.resource_id=$2) as usage_count`,
      [workspaceId, previewRunId],
    ),
  ).then((result) => result.rows[0]);
}

export function providerEffectCount(effectKey: string): Promise<number> {
  return withTenantScopedWorker((client) =>
    client.query<{ invocation_count: number }>(
      `select invocation_count from app.preview_process_provider_effects
       where workspace_id=$1 and effect_key=$2`,
      [workspaceId, effectKey],
    ),
  ).then((result) => result.rows[0]?.invocation_count ?? 0);
}

export function withTenantScopedWorker<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTenantScopedClient(workerPool, { workspaceId }, work);
}
