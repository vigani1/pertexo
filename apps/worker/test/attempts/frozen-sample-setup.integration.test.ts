import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  installHttpNodeAttemptFixture,
  withOwner,
  workerQuery,
  waitFor,
  workspaceId,
} from '../support/attempts/http-node-attempt.js';
import {
  describeIntegration,
  prepareHttpIntegrationTestTsFixture,
  resetHttpIntegrationTestTsFixture,
  fixtureEncryption,
  admitProviderScenario,
  advanceScenario,
  attemptJob,
  closeProofRuntime,
} from './http/http.fixture.js';
import { createHttpNodeAttemptProofRuntime } from '../support/attempts/http-node-attempt.runtime.js';

installHttpNodeAttemptFixture();
beforeAll(prepareHttpIntegrationTestTsFixture);
beforeEach(resetHttpIntegrationTestTsFixture);
describeIntegration('Frozen sample setup through the production reader', () => {
  it.each(['healthy', 'missing', 'non-inline', 'invalid-snapshot'] as const)(
    'preserves healthy frozen work and settles %s stored sample or snapshot state',
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
                  outputRef:
                    shape !== 'non-inline'
                      ? { kind: 'inline', value: { validSample: true } }
                      : { kind: 'artifact', artifactId: randomUUID() },
                },
              };
        await withOwner(async (client) => {
          // Use this run's graph: an unrelated graph can hide sample errors as a missing node.
          const original = await client.query<{ workflow_version_id: string }>(
            'select workflow_version_id from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          );
          const sourceVersionId = original.rows[0]?.workflow_version_id;
          if (sourceVersionId === undefined)
            throw new Error('Missing source version');
          await client.query(
            `insert into app.workflow_test_snapshots(id,workflow_id,workspace_id,draft_revision,graph_json,checksum,executable_json,dispositions,pins,expires_at)
          select $1,workflow_id,workspace_id,1,graph_json,checksum,executable_json,'{"provider":"pinned"}'::jsonb,$3::json,clock_timestamp()+interval '1 day' from app.workflow_versions where id=$2`,
            [snapshotId, sourceVersionId, JSON.stringify(pins)],
          );
          if (shape === 'invalid-snapshot')
            await client.query(
              'update app.workflow_test_snapshots set executable_json=\'{"corrupt":true}\'::json where id=$1',
              [snapshotId],
            );
          await client.query(
            `with moved as (update app.workflow_runs set workflow_version_id=$2,trigger_type='test' where id=$1 returning id)
            update app.run_checkpoints set workflow_version_id=$2,
            scheduler_state=replace(scheduler_state::text,$3::text,$2::text)::jsonb where workflow_run_id in (select id from moved)`,
            [scenario.accepted.runId, snapshotId, sourceVersionId],
          );
          await client.query(
            'update app.node_runs set invocation_key=replace(invocation_key,$2,$3) where workflow_run_id=$1',
            [scenario.accepted.runId, sourceVersionId, snapshotId],
          );
          await client.query(
            'update app.run_events set payload=replace(payload::text,$2,$3)::jsonb where workflow_run_id=$1',
            [scenario.accepted.runId, sourceVersionId, snapshotId],
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
        if (shape === 'healthy') {
          expect(
            await workerQuery(
              'select output_ref from app.node_attempts where id=$1',
              [scenario.attempt.attempt_id],
            ),
          ).toEqual([
            { output_ref: { kind: 'inline', value: { validSample: true } } },
          ]);
          await advanceScenario(
            runtime,
            scenario.accepted.runId,
            scenario.coordinatorOutboxes,
            'Settle healthy frozen sample',
          );
        }
        expect(
          await workerQuery(
            'select status,error_summary,completed_at is not null as completed from app.workflow_runs where id=$1',
            [scenario.accepted.runId],
          ),
        ).toEqual([
          {
            status: shape === 'healthy' ? 'succeeded' : 'failed',
            error_summary:
              shape === 'healthy' ? null : 'execution.run_state_invalid',
            completed: true,
          },
        ]);
        expect(
          await workerQuery(
            'select status,dispatch_marked_at from app.node_attempts where id=$1',
            [scenario.attempt.attempt_id],
          ),
        ).toEqual([
          {
            status: shape === 'healthy' ? 'succeeded' : 'canceled',
            dispatch_marked_at: null,
          },
        ]);
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
