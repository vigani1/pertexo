import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE } from '@pertexo/node-catalog';

import {
  cleanupFixture,
  databaseUrl,
  enabled,
  parseDatabaseConfig,
  restoreServices,
  setupFixture,
  workerQuery,
  workerUrl,
  workspaceId,
} from './coordinator-consumer.fixtures.js';
import {
  acceptReplayRun,
  acceptRun,
  createCoordinatorRedeliveryHarness,
} from './support/coordinator-run-fixtures.js';
import { createCoordinatorRecoveryHarness } from './support/coordinator-recovery-harness.js';

const describeIntegration = enabled ? describe : describe.skip;

describeIntegration('Coordinator exact redelivery resilience', () => {
  beforeAll(setupFixture, 60_000);
  afterAll(async () => {
    await restoreServices();
    await cleanupFixture();
  });

  it('advances an accepted V2 run once across exact BullMQ redelivery', async () => {
    const accepted = await acceptRun();
    const recovery = await createCoordinatorRedeliveryHarness(accepted);

    try {
      await recovery.publishInitial();
      const facts = await workerQuery<{
        attempt_count: string;
        event_types: string[];
        node_count: string;
        pending_attempt_jobs: string;
      }>(
        `select
             (select count(*)::text from app.node_runs
               where workspace_id = $1 and workflow_run_id = $2) as node_count,
             (select count(*)::text from app.node_attempts attempt
               join app.node_runs node on node.workspace_id = attempt.workspace_id
                and node.id = attempt.node_run_id
               where node.workspace_id = $1 and node.workflow_run_id = $2) as attempt_count,
             (select array_agg(type order by sequence) from app.run_events
               where workspace_id = $1 and workflow_run_id = $2) as event_types,
             (select count(*)::text from app.outbox_events
               where workspace_id = $1 and payload->>'runId' = $2::text
                 and job_name = 'execute-node-attempt'
                 and published_at is null and failed_at is null) as pending_attempt_jobs`,
        [workspaceId, accepted.runId],
      );
      expect(facts).toEqual([
        {
          node_count: '1',
          attempt_count: '1',
          event_types: ['run.queued', 'run.started', 'node.ready'],
          pending_attempt_jobs: '1',
        },
      ]);

      await recovery.redeliver();

      await expect(
        workerQuery<{ attempts: string; events: string; revision: number }>(
          `select checkpoint.revision,
               (select count(*)::text from app.run_events event
                 where event.workspace_id = checkpoint.workspace_id
                   and event.workflow_run_id = checkpoint.workflow_run_id) as events,
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id = attempt.workspace_id
                  and node.id = attempt.node_run_id
                 where node.workspace_id = checkpoint.workspace_id
                   and node.workflow_run_id = checkpoint.workflow_run_id) as attempts
             from app.run_checkpoints checkpoint
             where checkpoint.workspace_id = $1
               and checkpoint.workflow_run_id = $2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ revision: 1, events: '3', attempts: '1' }]);
    } finally {
      await recovery.close();
    }
  });

  it('delivers and redelivers a replay run without losing lineage or effects', async () => {
    const accepted = await acceptReplayRun();
    expect(accepted.runId).not.toBe(accepted.sourceRunId);
    const recovery = await createCoordinatorRedeliveryHarness(accepted);

    try {
      await recovery.publishInitial();

      const lineageRows = await workerQuery<{
        event_types: string[];
        input_ref: unknown;
        replay_command_id: string;
        replay_source_run_id: string;
        trigger_type: string;
      }>(
        `select run.trigger_type,run.replay_source_run_id,
                run.replay_command_id,run.input_ref,
                (select array_agg(type order by sequence)
                   from app.run_events event
                  where event.workspace_id=run.workspace_id
                    and event.workflow_run_id=run.id) event_types
           from app.workflow_runs run
          where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.runId],
      );
      expect(lineageRows).toHaveLength(1);
      const lineage = lineageRows[0];
      expect(lineage).toBeDefined();
      expect(lineage?.event_types).toEqual([
        'run.queued',
        'run.started',
        'node.ready',
      ]);
      expect(lineage?.input_ref).toEqual({
        kind: 'inline',
        schemaVersion: 1,
        value: { name: 'Replay' },
      });
      expect(lineage?.replay_command_id).toEqual(expect.any(String));
      expect(lineage?.replay_source_run_id).toBe(accepted.sourceRunId);
      expect(lineage?.trigger_type).toBe('replay');

      await recovery.redeliver();

      await expect(
        workerQuery<{ attempts: string; events: string; revision: number }>(
          `select checkpoint.revision,
               (select count(*)::text from app.run_events event
                 where event.workspace_id=checkpoint.workspace_id
                   and event.workflow_run_id=checkpoint.workflow_run_id) as events,
               (select count(*)::text from app.node_attempts attempt
                 join app.node_runs node on node.workspace_id = attempt.workspace_id
                  and node.id = attempt.node_run_id
                 where node.workspace_id = checkpoint.workspace_id
                   and node.workflow_run_id = checkpoint.workflow_run_id) as attempts
             from app.run_checkpoints checkpoint
             where checkpoint.workspace_id = $1
               and checkpoint.workflow_run_id = $2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([{ revision: 1, events: '3', attempts: '1' }]);
    } finally {
      await recovery.close();
    }
  });
  it('executes an accepted replay to terminal output across fresh workers', async () => {
    const accepted = await acceptReplayRun();
    const sourceSnapshot = () =>
      workerQuery(
        `select to_jsonb(run) run,
                (select count(*)::int from app.run_events event
                  where event.workspace_id=run.workspace_id
                    and event.workflow_run_id=run.id) event_count,
                (select scheduler_state from app.run_checkpoints checkpoint
                  where checkpoint.workspace_id=run.workspace_id
                    and checkpoint.workflow_run_id=run.id) checkpoint
           from app.workflow_runs run
          where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.sourceRunId],
      );
    const originalSource = await sourceSnapshot();
    const resolveConnection = vi.fn(() =>
      Promise.reject(new Error('not used')),
    );
    const writeArtifact = vi.fn(() => Promise.reject(new Error('not used')));
    const recovery = await createCoordinatorRecoveryHarness({
      accepted,
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
        max: 6,
      }),
      registryRelease: PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      runtimeCapabilities: {
        connections: () => ({ resolve: resolveConnection }),
        artifacts: () => ({ write: writeArtifact }),
      },
      workerIdPrefix: 'replay-terminal',
    });
    try {
      await recovery.publishCoordinator(accepted.outboxEventId, 1);
      await recovery.executeNext('manual');
      await recovery.continueAfter(2);
      await recovery.executeNext('set');
      await recovery.continueAfter(3);
      await recovery.restart({ obliterateQueues: true });
      await recovery.executeNext('terminate');
      await recovery.continueAfter(4);
      await expect(
        workerQuery(
          `select run.status,run.replay_source_run_id,node.output_ref,
                  (select count(*)::int from app.node_attempts attempt
                    join app.node_runs owned on owned.workspace_id=attempt.workspace_id
                      and owned.id=attempt.node_run_id
                   where owned.workspace_id=run.workspace_id
                     and owned.workflow_run_id=run.id) attempt_count
             from app.workflow_runs run
             join app.node_runs node on node.workspace_id=run.workspace_id
               and node.workflow_run_id=run.id and node.node_id='terminate'
            where run.workspace_id=$1 and run.id=$2`,
          [workspaceId, accepted.runId],
        ),
      ).resolves.toEqual([
        {
          status: 'succeeded',
          replay_source_run_id: accepted.sourceRunId,
          attempt_count: 3,
          output_ref: {
            kind: 'inline',
            schemaVersion: 1,
            value: { result: { literal: 1, fromRun: 'Replay' } },
          },
        },
      ]);
      await expect(sourceSnapshot()).resolves.toEqual(originalSource);
      expect(resolveConnection).not.toHaveBeenCalled();
      expect(writeArtifact).not.toHaveBeenCalled();
    } finally {
      await recovery.close();
    }
  }, 30_000);
});
