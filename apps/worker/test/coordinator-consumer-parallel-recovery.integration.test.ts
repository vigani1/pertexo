import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE } from '@pertexo/node-catalog';

import {
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  cleanupFixture,
  databaseUrl,
  enabled,
  parseCheckpoint,
  parseDatabaseConfig,
  restoreServices,
  setupFixture,
  workerQuery,
  workerUrl,
  workspaceId,
} from './coordinator-consumer.fixtures.js';
import {
  acceptNestedParallelRun,
  acceptParallelRun,
} from './support/coordinator-run-fixtures.js';
import { createCoordinatorRecoveryHarness } from './support/coordinator-recovery-harness.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Parallel and Merge Redis-loss recovery', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('recovers bounded Parallel and settled Merge after Redis loss on fresh workers', async () => {
    const accepted = await acceptParallelRun();
    const recovery = await createCoordinatorRecoveryHarness({
      accepted,
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      registryRelease: PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
      runtimeCapabilities: {
        connections: () => ({
          resolve: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
        artifacts: () => ({
          write: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
      },
      workerIdPrefix: 'parallel',
    });

    try {
      await recovery.publishCoordinator(accepted.outboxEventId, 1);
      await recovery.executeNext('manual');
      await recovery.continueAfter(2);
      const parallelAttempt = await recovery.executeNext('parallel');
      const parallelContinuation = await recovery.nextCoordinatorOutbox();
      await recovery.redeliverAttempt(parallelAttempt);
      await recovery.restart({ obliterateQueues: true });

      await recovery.publishCoordinator(parallelContinuation, 3);
      await recovery.publishCoordinator(parallelContinuation, 3);
      const bounded = await workerQuery<{
        attempt_count: string;
        node_id: string;
        status: string;
      }>(
        `select node_id,status,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs attempt_node on attempt_node.id=attempt.node_run_id
                   where attempt_node.workflow_run_id=$2
                     and attempt_node.node_id in ('left','right')) attempt_count
             from app.node_runs
           where workspace_id=$1 and workflow_run_id=$2
             and node_id in ('left','right') order by node_id`,
        [workspaceId, accepted.runId],
      );
      expect(bounded).toEqual([
        { attempt_count: '1', node_id: 'left', status: 'ready' },
        { attempt_count: '1', node_id: 'right', status: 'ready' },
      ]);

      await recovery.executeNext('left');
      await recovery.continueAfter(4);
      await recovery.executeNext('right');
      await recovery.continueAfter(5);
      await recovery.executeNext('merge');
      await recovery.continueAfter(6);
      await recovery.executeNext('terminate');
      await recovery.continueAfter(7);

      const terminal = await workerQuery<{
        attempts: string;
        scheduler_state: unknown;
      }>(
        `select checkpoint.scheduler_state,
                  (select count(*)::text from app.node_attempts attempt
                    join app.node_runs node on node.id=attempt.node_run_id
                   where node.workflow_run_id=$2) attempts
             from app.run_checkpoints checkpoint
            where checkpoint.workspace_id=$1 and checkpoint.workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(terminal[0]?.attempts).toBe('6');
      expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject({
        schemaVersion: 2,
        runStatus: 'succeeded',
        joins: [
          {
            joinId: 'merge',
            selectedBranchIds: ['branch-01', 'branch-02'],
          },
        ],
      });
    } finally {
      await recovery.close();
    }
  }, 30_000);

  it('persists nested Parallel caps independently per For Each iteration', async () => {
    const accepted = await acceptNestedParallelRun();
    const recovery = await createCoordinatorRecoveryHarness({
      accepted,
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      registryRelease: PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      runtimeCapabilities: {
        connections: () => ({
          resolve: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
        artifacts: () => ({
          write: vi.fn(() => Promise.reject(new Error('not used'))),
        }),
      },
      workerIdPrefix: 'nested-parallel',
    });

    try {
      await recovery.publishCoordinator(accepted.outboxEventId, 1);
      await recovery.executeNext('manual');
      await recovery.continueAfter(2);
      await recovery.executeNext('loop');
      await recovery.continueAfter(3);
      await recovery.executeNext('parallel', 0);
      await recovery.continueAfter(4);
      await recovery.executeNext('parallel', 1);
      const lastContinuation = await recovery.continueAfter(5);

      await recovery.restart();

      await recovery.publishCoordinator(lastContinuation, 5);
      await recovery.publishCoordinator(lastContinuation, 5);

      await recovery.executeNext('left', 0);
      await recovery.continueAfter(6);

      const branchRuns = await workerQuery<{
        attempt_count: string;
        node_id: string;
        ordinal: number;
        status: string;
      }>(
        `select node.node_id,
                (node.branch_context->'iterationPath'->0->>'ordinal')::int ordinal,
                node.status,
                count(attempt.id)::text attempt_count
           from app.node_runs node
           left join app.node_attempts attempt
             on attempt.workspace_id=node.workspace_id
            and attempt.node_run_id=node.id
          where node.workspace_id=$1 and node.workflow_run_id=$2
            and node.node_id in ('left','right')
          group by node.node_id,ordinal,node.status
          order by ordinal,node.node_id`,
        [workspaceId, accepted.runId],
      );
      expect(branchRuns).toEqual([
        {
          attempt_count: '1',
          node_id: 'left',
          ordinal: 0,
          status: 'succeeded',
        },
        {
          attempt_count: '1',
          node_id: 'right',
          ordinal: 0,
          status: 'ready',
        },
        {
          attempt_count: '1',
          node_id: 'left',
          ordinal: 1,
          status: 'ready',
        },
        {
          attempt_count: '0',
          node_id: 'right',
          ordinal: 1,
          status: 'ready',
        },
      ]);
      const checkpoints = await workerQuery<{ scheduler_state: unknown }>(
        `select scheduler_state from app.run_checkpoints
           where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(parseCheckpoint(checkpoints[0]?.scheduler_state)).toMatchObject({
        remainingIterationBudget: 0,
        loops: [
          {
            activeOrdinals: [0, 1],
            nextOrdinal: 2,
            terminalOrdinals: [],
          },
        ],
      });
    } finally {
      await recovery.close();
    }
  }, 30_000);
});
