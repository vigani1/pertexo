import { randomUUID } from 'node:crypto';
import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import { createWorkflowCallStore } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import { expect, it } from 'vitest';
import { createCoordinatorRecoveryHarness } from '../../../support/coordinator/recovery-harness.js';
import {
  accept,
  childGraph,
  edge,
  fixture,
  node,
  parentGraph,
  publishGraph,
  runtime,
} from '../fixtures.js';

export function registerRecoversDurableCallIdentityAcrossPaused(): void {
  it('recovers durable Call identity across paused workers and uncompleted action redelivery', async () => {
    const child = await publishGraph(childGraph());
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    const actions = createWorkflowCallStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.dispatcherUrl),
        max: 2,
      }),
    );
    try {
      await workers.pause();
      // Deliver one transition at a time so action redelivery starts from a stable intent.
      const preparation = await createCoordinatorRecoveryHarness({
        accepted,
        database: parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 6,
        }),
        runtimeCapabilities: {},
        workerIdPrefix: 'call-intent',
      });
      try {
        await preparation.publishCoordinator(accepted.outboxEventId, 1);
        await preparation.executeNext('manual');
        await preparation.continueAfter(2);
        await preparation.executeNext('call');
        await preparation.continueAfter(3);
      } finally {
        await preparation.close();
      }
      expect(
        await fixture.workerQuery(
          'select status from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual([{ status: 'pending' }]);
      const id = randomUUID();
      const payload = {
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
        outboxEventId: id,
      };
      const hint = {
        id,
        payload_checksum: canonicalOutboxPayloadChecksum(payload),
      };
      await fixture.ownerQuery(
        `insert into app.outbox_events(id,workspace_id,aggregate_type,aggregate_id,job_name,payload,payload_checksum) values($1,$2,'workflow-run',$3,'advance-workflow-run',$4::jsonb,$5)`,
        [
          id,
          fixture.workspaceId,
          accepted.runId,
          JSON.stringify(payload),
          hint.payload_checksum,
        ],
      );
      const input = {
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
        signal: new AbortController().signal,
        delivery: {
          outboxEventId: hint.id,
          payloadChecksum: hint.payload_checksum,
        },
      };
      const prepare = (
        projection: Parameters<Parameters<typeof actions.performActions>[1]>[0],
      ) =>
        createInitialCheckpoint(projection, {
          catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
        });
      await actions.performActions(input, prepare);
      const [call] = await fixture.workerQuery<{
        id: string;
        child_run_id: string;
      }>(
        'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
        [accepted.runId],
      );
      if (call === undefined) throw new Error('Accepted child missing');
      expect(
        await fixture.workerQuery(
          'select completed_at from app.inbox_receipts where message_id=$1',
          [hint.id],
        ),
      ).toEqual([]);
      await fixture.ownerQuery(
        'delete from app.idempotency_records where scope=$1',
        [`workflow-call:${call.id}`],
      );
      await actions.performActions(input, prepare);
      expect(
        await fixture.workerQuery(
          'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual([call]);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
      expect(
        await fixture.workerQuery(
          'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual([call]);
    } finally {
      await actions.close();
      await workers.close();
    }
  }, 30_000);

  it('serializes parallel Call intents in stable invocation order without allocating an unreserved second child', async () => {
    const child = await publishGraph(childGraph(1));
    const call = (id: string, name: string) => ({
      ...node(id, 'core.call'),
      config: { target: { ...child.pin } },
      inputMappings: { input: { kind: 'literal' as const, value: { name } } },
    });
    const parent = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('parallel', 'core.parallel'),
          config: {
            branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
            maxConcurrency: 2,
          },
        },
        call('call-a', 'Ada'),
        call('call-b', 'Bob'),
        {
          ...node('merge', 'core.merge'),
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        },
        node('finish', 'core.terminate'),
      ],
      edges: [
        edge('manual', 'parallel'),
        edge('parallel', 'call-a', 'branch-01'),
        edge('parallel', 'call-b', 'branch-02'),
        {
          ...edge('call-a', 'merge'),
          target: { nodeId: 'merge', port: 'branch-01' },
        },
        {
          ...edge('call-b', 'merge'),
          target: { nodeId: 'merge', port: 'branch-02' },
        },
        edge('merge', 'finish'),
      ],
    });
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select status,child_run_id is not null allocated,slot_lent from app.workflow_calls where parent_run_id=$1 order by invocation_key`,
            [accepted.runId],
          ),
        ).toEqual([
          { status: 'accepted', allocated: true, slot_lent: true },
          { status: 'pending', allocated: false, slot_lent: false },
        ]);
      });
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
      expect(
        await fixture.workerQuery(
          'select status,result_ref from app.workflow_calls where parent_run_id=$1 order by invocation_key',
          [accepted.runId],
        ),
      ).toEqual([
        { status: 'succeeded', result_ref: { kind: 'inline', value: 'Ada!' } },
        { status: 'succeeded', result_ref: { kind: 'inline', value: 'Bob!' } },
      ]);
    } finally {
      await workers.close();
    }
  }, 30_000);
}
