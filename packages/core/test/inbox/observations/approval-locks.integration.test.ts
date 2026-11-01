import { readFolderScope } from '../../../src/shared/facts.queries.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Pool } from 'pg';
import { apiUrl } from '../../support/workflow-authoring.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { readAttentionFact } from '../../../src/inbox/observations/facts.queries.js';
import { respondToTask } from '../../../src/runs/pending-tasks/responses/respond.repository.js';
import { seedApproval, seedNoticeWorkspace } from '../notices.fixture.js';

it('lets an approval decision finish while its notice waits for the same run', async () => {
  const f = await seedNoticeWorkspace();
  const task = await seedApproval(f.workspaceId, f.workflowId, {
    starter: f.members.owner,
  });
  const pool = new Pool({ connectionString: apiUrl, max: 3 });
  let observerPid: number | undefined;
  let observed:
    | Promise<
        PromiseSettledResult<Awaited<ReturnType<typeof readAttentionFact>>>[]
      >
    | undefined;
  try {
    const decision = await withTenantScopedClient(
      pool,
      { workspaceId: f.workspaceId, actorId: f.members.admin },
      async (client) => {
        const pid = (
          await client.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        await client.query(
          'select id from app.workflow_runs where workspace_id=$1 and id=$2 for no key update',
          [f.workspaceId, task.runId],
        );
        const observation = withTenantScopedClient(
          pool,
          { workspaceId: f.workspaceId },
          async (reader) => {
            observerPid = (
              await reader.query<{ pid: number }>('select pg_backend_pid() pid')
            ).rows[0]?.pid;
            return readAttentionFact(reader, {
              workspaceId: f.workspaceId,
              subjectId: task.taskId,
              noticeKind: 'approval_waiting',
            });
          },
        );
        observed = Promise.allSettled([observation]);
        await expect
          .poll(
            async () => {
              if (observerPid === undefined) return [];
              const blocked = await pool.query<{ blockers: number[] }>(
                'select pg_blocking_pids($1) blockers',
                [observerPid],
              );
              return blocked.rows[0]?.blockers ?? [];
            },
            { timeout: 10_000 },
          )
          .toContain(pid);
        return await respondToTask(
          client,
          {
            workspaceId: f.workspaceId,
            actorId: f.members.admin,
            taskId: task.taskId,
            kind: 'approval',
            decision: 'approved',
            idempotencyKey: randomUUID(),
          },
          'admin',
          await readFolderScope(
            client,
            { workspaceId: f.workspaceId, actorId: f.members.admin },
            'admin',
          ),
        );
      },
    );
    expect(decision.task.status).toBe('approved');
    const result = (await observed)?.[0];
    expect(result?.status).toBe('fulfilled');
    if (result?.status !== 'fulfilled')
      throw new Error('Notice observation failed');
    expect(result.value.active).toBe(false);
  } finally {
    await observed;
    await pool.end();
  }
}, 15_000);
