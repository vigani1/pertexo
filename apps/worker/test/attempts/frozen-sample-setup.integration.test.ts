import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  withOwner,
  workerQuery,
  waitFor,
  workflowVersionId,
  workspaceId,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  admitProviderScenario,
  attemptJob,
  closeProofRuntime,
} from './http/fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Frozen sample setup through the production reader', () => {
  it.each(['missing', 'non-inline'] as const)(
    'ends an admitted test with a %s frozen sample',
    async (shape) => {
      if (fixtureEncryption === undefined) throw new Error('Missing fixture');
      let providerCalls = 0;
      const runtime = await createHttpNodeAttemptProofRuntime(
        fixtureEncryption,
        {
          sendSlackMessage: (request) => {
            providerCalls++;
            return Promise.resolve({
              kind: 'succeeded',
              channelId: request.channelId,
              messageTs: '1724412345.000100',
            });
          },
        },
      );
      try {
        const scenario = await admitProviderScenario(runtime, 'slack');
        const snapshotId = randomUUID();
        const pins =
          shape === 'missing'
            ? {}
            : {
                provider: {
                  sampleId: randomUUID(),
                  outputRef: { kind: 'artifact', artifactId: randomUUID() },
                },
              };
        await withOwner(async (client) => {
          await client.query(
            `insert into app.workflow_test_snapshots(id,workflow_id,workspace_id,draft_revision,graph_json,checksum,executable_json,dispositions,pins,expires_at)
          select $1,workflow_id,workspace_id,1,graph_json,checksum,executable_json,'{"provider":"pinned"}'::jsonb,$3::json,clock_timestamp()+interval '1 day' from app.workflow_versions where id=$2`,
            [snapshotId, workflowVersionId, JSON.stringify(pins)],
          );
          await client.query(
            'with moved as (update app.workflow_runs set workflow_version_id=$2 where id=$1 returning id) update app.run_checkpoints set workflow_version_id=$2 where workflow_run_id in (select id from moved)',
            [scenario.accepted.runId, snapshotId],
          );
        });
        const publication = await runtime.producer.publish(
          attemptJob(scenario.accepted.runId, scenario.attempt),
        );
        const job = await waitFor(
          () => runtime.attemptQueue.getJob(publication.jobId),
          (value) => value !== undefined,
        );
        if (job === undefined) throw new Error('Missing job');
        await waitFor(
          () => job.getState(),
          (state) => state === 'failed' || state === 'completed',
        );
        expect(
          await workerQuery(
            'select status,error_summary,completed_at is not null as completed from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([
          {
            status: 'failed',
            error_summary: 'execution.run_state_invalid',
            completed: true,
          },
        ]);
        expect(
          await workerQuery(
            'select status,dispatch_marked_at from app.node_attempts where id=$1',
            [scenario.attempt.attempt_id],
          ),
        ).toEqual([{ status: 'canceled', dispatch_marked_at: null }]);
        expect(
          await workerQuery(
            'select completed_at is not null as completed from app.inbox_receipts where message_id=$1',
            [scenario.attempt.outbox_id],
          ),
        ).toEqual([{ completed: true }]);
        expect(
          await workerQuery(
            'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
            [workspaceId],
          ),
        ).toEqual([{ active_runs: 0 }]);
        expect(providerCalls).toBe(0);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
});
