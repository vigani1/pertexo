import { it, expect } from 'vitest';

import { createOperatorCommandDatabase } from '../../../../../src/operator/commands.js';

import {
  apiBaseUrl,
  asOwner,
  asRuntime,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  randomUUID,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerLetsOperatorRecordCommandsReplays(): void {
  it('lets only the operator record commands and replays a fence dry run', async () => {
    const operatorBaseUrl =
      process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
    const operator = createOperatorCommandDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(operatorBaseUrl),
        max: 1,
      }),
    );
    try {
      await expect(operator.checkReadiness()).resolves.toBeUndefined();
      // Only the operator records commands.
      for (const roleUrl of [apiBaseUrl, workerBaseUrl]) {
        await expect(
          asRuntime(roleUrl, workspaceA, (client) =>
            client.query(
              `insert into app.operator_commands(
                 id,workspace_id,command_type,dry_run,request_fingerprint,
                 status,outcome,result
               ) values($1,$2,'run.cancel',true,$3,'completed','would_cancel','{}')`,
              [randomUUID(), workspaceA, 'a'.repeat(64)],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }

      const lease = await claimDispatchAttempt(
        `operator-fence-${randomUUID()}`,
      );
      const commandId = randomUUID();
      const command = {
        action: 'reclaim' as const,
        actorRef: 'operator:test',
        attemptId: lease.attemptId,
        commandId,
        dryRun: true,
        expectedFenceToken: lease.fenceToken + 1,
        reason: 'inspect stale attempt fence',
        workspaceId: workspaceA,
      };
      const first = await operator.reconcileAttempt(command);
      expect(first).toMatchObject({
        outcome: 'fence_conflict',
        replayed: false,
        result: { fenceToken: lease.fenceToken + 1 },
      });
      await expect(operator.reconcileAttempt(command)).resolves.toEqual({
        ...first,
        replayed: true,
      });
      await expect(
        operator.reconcileAttempt({
          ...command,
          reason: 'conflicting attempt reason',
        }),
      ).rejects.toThrow('conflicts');

      const facts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          audit_count: number;
          command_count: number;
          fence_token: string;
          status: string;
        }>(
          `select attempt.status,attempt.fence_token::text,
              (select count(*)::int from app.operator_commands where id=$2)
                command_count,
              (select count(*)::int from app.audit_events
                where workspace_id=$1 and request_id=$2::text)
                audit_count
           from app.node_attempts attempt
           where attempt.workspace_id=$1 and attempt.id=$3`,
          [workspaceA, commandId, lease.attemptId],
        ),
      );
      expect(facts.rows[0]).toEqual({
        audit_count: 3,
        command_count: 1,
        fence_token: String(lease.fenceToken),
        status: 'running',
      });
      const record = await operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'inspect durable command projection',
        workspaceId: workspaceA,
      });
      expect(record).toMatchObject({
        commandId,
        commandType: 'attempt.reconcile',
        status: 'completed',
        outcome: 'fence_conflict',
      });
      expect(record?.createdAt).toBeInstanceOf(Date);
      expect(record?.completedAt).toBeInstanceOf(Date);
      expect(Object.isFrozen(record)).toBe(true);
    } finally {
      await operator.close();
    }
  });

  it('preserves exact 100/101 due-work boundaries and dry-run nonmutation', async () => {
    const operatorBaseUrl =
      process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
    const operator = createOperatorCommandDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(operatorBaseUrl),
        max: 1,
      }),
    );
    const seedDueRun = async (count: number): Promise<string> => {
      const runId = await insertRun({ status: 'running' });
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class,retry_due_at,wait_kind
           )
           select gen_random_uuid(),$1,$2,'operator-due-'||item::text,
             $3||'|operator-due-'||item::text||'|b:|i:',
             '{}'::jsonb,'waiting','safe',
             clock_timestamp()-interval '1 minute','retry_backoff'
           from generate_series(1,$4::integer) item`,
          [workspaceA, runId, versionA, count],
        ),
      );
      return runId;
    };
    try {
      const hundredRunId = await seedDueRun(100);
      const hundredOneRunId = await seedDueRun(101);
      const inspect = async (runId: string) => {
        const command = {
          actorRef: 'operator:test',
          commandId: randomUUID(),
          dryRun: true,
          reason: 'inspect bounded due work',
          runId,
          workspaceId: workspaceA,
        };
        const result = await operator.resumeDueWork(command);
        await expect(operator.resumeDueWork(command)).resolves.toEqual({
          ...result,
          replayed: true,
        });
        return result;
      };

      await expect(inspect(hundredRunId)).resolves.toMatchObject({
        outcome: 'would_resume',
        result: { dueNodeCount: 100, dueNodesRemaining: false },
      });
      await expect(inspect(hundredOneRunId)).resolves.toMatchObject({
        outcome: 'would_resume',
        result: { dueNodeCount: 100, dueNodesRemaining: true },
      });
      const before = await asOwner(workspaceA, (client) =>
        client.query<{ awakened: number; outbox: number }>(
          `select
             (select count(*)::int from app.node_runs
               where workspace_id=$1 and workflow_run_id=any($2::uuid[])
                 and due_wakeup_at is not null) awakened,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=any($2::uuid[])
                 and job_name='advance-workflow-run') outbox`,
          [workspaceA, [hundredRunId, hundredOneRunId]],
        ),
      );
      expect(before.rows).toEqual([{ awakened: 0, outbox: 0 }]);

      const firstResume = await operator.resumeDueWork({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        dryRun: false,
        reason: 'resume first bounded due page',
        runId: hundredOneRunId,
        workspaceId: workspaceA,
      });
      expect(firstResume).toMatchObject({
        outcome: 'resumed',
        result: { dueNodeCount: 100, dueNodesRemaining: true },
      });
      const secondResume = await operator.resumeDueWork({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        dryRun: false,
        reason: 'resume final bounded due page',
        runId: hundredOneRunId,
        workspaceId: workspaceA,
      });
      expect(secondResume).toMatchObject({
        outcome: 'resumed',
        result: { dueNodeCount: 1, dueNodesRemaining: false },
      });
      const after = await asOwner(workspaceA, (client) =>
        client.query<{ awakened: number; outbox: number }>(
          `select
             (select count(*)::int from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2
                 and due_wakeup_at is not null) awakened,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run') outbox`,
          [workspaceA, hundredOneRunId],
        ),
      );
      expect(after.rows).toEqual([{ awakened: 101, outbox: 2 }]);
    } finally {
      await operator.close();
    }
  });
}
