import { Pool } from 'pg';
import { readWorkflowNodeRunDiagnostics } from '../../../../../src/runs/queries/history/details.queries.js';

import { it, expect } from 'vitest';

import {
  NodeAttemptStateCorruptError,
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  databaseUrl,
  nodeAttemptStore,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerLeasesAdmittedButUnstartedWork(): void {
  it.each(['canceled', 'timed_out'] as const)(
    'leases admitted but unstarted work solely to settle %s',
    async (control) => {
      const lease = await claimDispatchAttempt(`control-${randomUUID()}`, {
        sideEffectClass: 'unsafe',
        control,
      });
      await expect(
        nodeAttemptStore.loadInputs({
          lease,
          upstreamNodeOutputs: [],
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ control: { kind: 'abort', reason: control } });
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: {
            status: control,
            safeErrorCode:
              control === 'canceled'
                ? 'execution.canceled'
                : 'execution.deadline_exceeded',
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'committed' });
      const result = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          'select status,dispatch_marked_at from app.node_attempts where id=$1',
          [lease.attemptId],
        ),
      );
      expect(result.rows).toEqual([
        { status: control, dispatch_marked_at: null },
      ]);
    },
  );

  it('commits private Code diagnostics with completion, compares duplicates and hides expired or foreign data', async () => {
    const lease = await claimDispatchAttempt(
      `code-diagnostic-${randomUUID()}`,
      { sideEffectClass: 'safe' },
    );
    const codeDiagnostics = {
      logs: [{ level: 'info' as const, message: 'private run data' }],
      truncated: false,
      error: { message: 'user-only diagnostic', line: 2 },
    };
    const outcome = {
      status: 'executor_failure',
      failureKind: 'failed',
      errorKind: 'internal',
      possiblyDispatched: false,
      safeErrorCode: 'code.runtime_error',
    } as const;
    const signal = new AbortController().signal;
    expect(
      (
        await nodeAttemptStore.complete({
          lease,
          outcome,
          codeDiagnostics,
          signal,
        })
      ).kind,
    ).toBe('committed');
    expect(
      (
        await nodeAttemptStore.complete({
          lease,
          outcome,
          codeDiagnostics,
          signal,
        })
      ).kind,
    ).toBe('duplicate');
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        codeDiagnostics: { ...codeDiagnostics, logs: [] },
        signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    const read = {
      actorId,
      workspaceId: workspaceA,
      runId: lease.runId,
      nodeRunId: lease.nodeRunId,
    };
    try {
      expect(await readWorkflowNodeRunDiagnostics(pool, read)).toEqual(
        codeDiagnostics,
      );
      expect(
        await readWorkflowNodeRunDiagnostics(pool, {
          ...read,
          runId: randomUUID(),
        }),
      ).toBeUndefined();
      expect(
        await readWorkflowNodeRunDiagnostics(pool, {
          ...read,
          workspaceId: randomUUID(),
        }),
      ).toBeUndefined();
      const summaries = await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          'select error_summary,safe_error_code from app.node_attempts where workspace_id=$1 and id=$2',
          [workspaceA, lease.attemptId],
        ),
      );
      expect(summaries.rows).toEqual([
        { error_summary: null, safe_error_code: 'code.runtime_error' },
      ]);
      await asOwner(workspaceA, (client) =>
        client.query(
          "update app.workflow_runs set status='failed',completed_at=clock_timestamp()-interval '31 days' where workspace_id=$1 and id=$2",
          [workspaceA, lease.runId],
        ),
      );
      expect(await readWorkflowNodeRunDiagnostics(pool, read)).toBeNull();
    } finally {
      await pool.end();
    }
  });
}
