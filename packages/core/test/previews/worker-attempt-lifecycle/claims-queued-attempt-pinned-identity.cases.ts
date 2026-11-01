import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.repository.js';
import { completePreviewAttempt } from '../../../src/previews/attempts/completion.repository.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import {
  acceptFixture,
  actorUserId,
  apiPool,
  claimFixture,
  previewTerminalFacts,
  scopedQuery,
  withOwnerRole,
  workerPool,
  workspaceId,
  workflowId,
} from '../worker.fixture.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';

export function registerClaimsQueuedAttemptPinnedIdentity(): void {
  it('hands the worker the set captured at admission, not the current one', async () => {
    const setHead = (values: string) =>
      withOwnerRole((client) =>
        client.query(
          `with next_set as (
             insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
             select $1,coalesce(max(revision),0)+1,$2::jsonb
               from app.workspace_variable_set_revisions where workspace_id=$1
             returning revision
           )
           insert into app.workspace_variables(workspace_id,revision)
           select $1,revision from next_set
           on conflict (workspace_id) do update set revision=excluded.revision`,
          [workspaceId, values],
        ),
      );
    await setHead('{"RATE":10}');
    const accepted = await acceptFixture();
    await setHead('{"RATE":20}');
    const claimed = await claimFixture(accepted, 'worker-preview-variables');
    expect(claimed.lease.variables).toEqual({ RATE: 10 });
  });

  it('claims a queued attempt with pinned identity and completes truthfully', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-a',
    );
    expect(claimed.lease).toMatchObject({
      attemptFenceToken: 1,
      definitionKey: 'http.request',
      definitionVersion: 1,
      dryRun: 'not_supported',
      executorKey: 'http.request',
      executorVersion: 2,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      nodeId: 'node-1',
      operationKey: 'request',
      providerKey: 'http',
      sideEffectClass: 'unsafe',
      workspaceId,
      workflowId,
    });
    expect(claimed.lease.input).toMatchObject({ kind: 'inline' });
    expect(claimed.lease.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u,
    );
    expect(claimed.lease.executionDeadlineAt.getTime()).toBeGreaterThan(
      Date.now(),
    );

    const attemptState = await scopedQuery<{
      status: string;
      started_at: Date | null;
    }>(
      `select status,started_at from app.preview_attempts
       where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(attemptState.rows[0]).toMatchObject({ status: 'running' });
    expect(attemptState.rows[0]?.started_at).not.toBeNull();

    const completed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        output: {
          kind: 'inline',
          value: { done: true },
        },
        status: PREVIEW_STATUS.succeeded,
      },
      workerId: claimed.workerId,
    });
    expect(completed.kind).toBe('committed');

    const runState = await scopedQuery<{
      attempt_output_ref: unknown;
      attempt_output_type: string | null;
      status: string;
      output_ref: unknown;
      output_type: string | null;
      safe_error_code: string | null;
      completed_at: Date | null;
    }>(
      `select run.status,run.output_ref,run.safe_error_code,run.completed_at,
              json_typeof(run.output_ref) as output_type,
              attempt.output_ref as attempt_output_ref,
              json_typeof(attempt.output_ref) as attempt_output_type
       from app.preview_runs run
       join app.preview_attempts attempt
         on attempt.workspace_id=run.workspace_id
        and attempt.preview_run_id=run.id
       where run.workspace_id=$1 and run.id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(runState.rows[0]).toMatchObject({
      attempt_output_ref: {
        kind: 'inline',
        value: { done: true },
      },
      attempt_output_type: 'object',
      output_ref: {
        kind: 'inline',
        value: { done: true },
      },
      output_type: 'object',
      safe_error_code: null,
      status: 'succeeded',
    });
    expect(runState.rows[0]?.completed_at).not.toBeNull();

    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    const auditId = facts.audit[0]?.id;
    const usageId = facts.usage[0]?.id;
    const uuidV7Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(auditId).toMatch(uuidV7Pattern);
    expect(usageId).toMatch(uuidV7Pattern);
    expect(facts.audit).toEqual([
      {
        actor_user_id: actorUserId,
        id: auditId,
        metadata: {
          status: PREVIEW_STATUS.succeeded,
          workflowId,
          nodeId: 'node-1',
          definitionKey: 'http.request',
          definitionVersion: 1,
          executorKey: 'http.request',
          executorVersion: 2,
          dryRun: 'not_supported',
          sideEffectClass: 'unsafe',
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          previewAttemptId: claimed.fixture.previewAttemptId,
        },
        request_id: 'preview-request-id',
        trace_id: 'preview-trace-id',
      },
    ]);
    expect(facts.usage).toEqual([
      {
        category: 'preview_execution',
        id: usageId,
        idempotency_key: `preview-terminal:${claimed.fixture.previewRunId}`,
        metadata: {
          status: PREVIEW_STATUS.succeeded,
          definitionKey: 'http.request',
          executorKey: 'http.request',
          sideEffectClass: 'unsafe',
        },
        quantity: '1',
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('hello');
    expect(JSON.stringify(facts)).not.toContain('done');

    const otherWorkspaceFacts = await withTenantScopedClient(
      apiPool,
      { workspaceId: randomUUID() },
      (client) =>
        client.query<{ audit_count: string; usage_count: string }>(
          `select
             (select count(*)::text from app.audit_events
               where target_id=$1) as audit_count,
             (select count(*)::text from app.usage_events
               where resource_id=$1) as usage_count`,
          [claimed.fixture.previewRunId],
        ),
    );
    expect(otherWorkspaceFacts.rows).toEqual([
      { audit_count: '0', usage_count: '0' },
    ]);
  });

  it('makes exact redelivery after a terminal outcome an inbox duplicate', async () => {
    const fixture = await acceptFixture();
    const claimed = await claimFixture(fixture, 'worker-preview-b');
    const committed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(committed.kind).toBe('committed');

    const redelivered = await claimPreviewDelivery(workerPool, {
      delivery: fixture.delivery,
      leaseDurationSeconds: 30,
      previewAttemptId: fixture.previewAttemptId,
      previewRunId: fixture.previewRunId,
      workerId: 'worker-preview-c',
      workspaceId,
    });
    expect(redelivered).toEqual({ kind: 'duplicate' });

    // Completing again is an idempotent duplicate, not a second effect.
    const replayCompletion = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(replayCompletion.kind).toBe('duplicate');
    const facts = await previewTerminalFacts(fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.usage).toHaveLength(1);
  });
}
