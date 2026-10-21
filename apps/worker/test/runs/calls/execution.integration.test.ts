import { restrictAcceptedWorkflows } from '../../support/resources/sharing.js';
import { randomUUID } from 'node:crypto';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import { createWorkflowCallStore } from '@pertexo/database/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createInitialCheckpoint } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoordinatorRecoveryHarness } from '../../support/coordinator/recovery-harness.js';
import {
  accept,
  childGraph,
  edge,
  fixture,
  node,
  limitWorkspace,
  parentGraph,
  publishGraph,
  runtime,
} from './fixtures.js';

const describeIntegration = fixture.enabled ? describe : describe.skip;
describeIntegration('Workflow Call execution through real transport', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  it('resumes a typed Call after worker restart and preserves one child across receipt expiry and redelivery', async () => {
    const child = await publishGraph(childGraph(1));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select call.status,child.status child_status from app.workflow_calls call join app.workflow_runs child on child.workspace_id=call.workspace_id and child.id=call.child_run_id where call.parent_run_id=$1`,
            [accepted.runId],
          ),
        ).toEqual([{ status: 'accepted', child_status: 'waiting' }]);
      });
      const before = await fixture.workerQuery<{
        child_run_id: string;
        id: string;
      }>(
        'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
        [accepted.runId],
      );
      expect(before).toHaveLength(1);
      const call = before[0];
      if (call === undefined) throw new Error('Accepted Call missing');
      await fixture.ownerQuery(
        'delete from app.idempotency_records where scope=$1',
        [`workflow-call:${call.id}`],
      );
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual(before);
      expect(
        await fixture.workerQuery(
          'select status,slot_lent,consumed_at is not null consumed from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual([{ status: 'succeeded', slot_lent: false, consumed: true }]);
      expect(
        await fixture.workerQuery(
          'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).toEqual([]);
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('finishes an accepted published Call after its parent and child become private, without sharing child history', async () => {
    const child = await publishGraph(childGraph());
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const sharing = await restrictAcceptedWorkflows({
      ownerQuery: fixture.ownerQuery,
      workspaceId: fixture.workspaceId,
      workflowIds: [parent.workflowId, child.workflowId],
      apiUrl: fixture.databaseUrl(fixture.apiUrl),
    });
    const workers = await runtime();
    try {
      expect(await sharing.canRead(accepted.runId)).toBe(false);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      const call = (
        await fixture.workerQuery<{ child_run_id: string }>(
          'select child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        )
      )[0];
      if (!call) throw new Error('Missing delegated child');
      expect(await sharing.canRead(call.child_run_id)).toBe(false);
    } finally {
      await workers.close();
      await sharing.close();
    }
  }, 30_000);

  it('passes a single workspace slot down a nested chain and returns it through each parent', async () => {
    await limitWorkspace(1);
    const leaf = await publishGraph(childGraph(1));
    const middle = await publishGraph(parentGraph(leaf.pin));
    const root = await publishGraph(parentGraph(middle.pin));
    const accepted = await accept(root);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int loans from app.workflow_calls where workspace_id=$1 and slot_lent`,
            [fixture.workspaceId],
          ),
        ).toEqual([{ loans: 2 }]);
      });
      expect(
        await fixture.workerQuery(
          `select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ occupied: 1 }]);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          `select count(*)::int loans from app.workflow_calls where workspace_id=$1 and slot_lent`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ loans: 0 }]);
    } finally {
      await workers.close();
      await limitWorkspace(5);
    }
  }, 30_000);

  it('executes five waiting parents and five children in the default five slots', async () => {
    const child = await publishGraph(childGraph(2));
    const parents = await Promise.all(
      Array.from({ length: 5 }, () => publishGraph(parentGraph(child.pin))),
    );
    const accepted = await Promise.all(parents.map((parent) => accept(parent)));
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int loans from app.workflow_calls where parent_run_id=any($1::uuid[]) and slot_lent`,
            [accepted.map((run) => run.runId)],
          ),
        ).toEqual([{ loans: 5 }]);
      });
      expect(
        await fixture.workerQuery(
          `select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ occupied: 5 }]);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int finished from app.workflow_runs where id=any($1::uuid[]) and status='succeeded'`,
            [accepted.map((run) => run.runId)],
          ),
        ).toEqual([{ finished: 5 }]);
      });
      expect(
        await fixture.workerQuery(
          `select count(*)::int children from app.workflow_calls where parent_run_id=any($1::uuid[])`,
          [accepted.map((run) => run.runId)],
        ),
      ).toEqual([{ children: 5 }]);
    } finally {
      await workers.close();
    }
  }, 30_000);

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

  it('executes and prunes Calls in two serial For Each iterations', async () => {
    const child = await publishGraph(childGraph());
    const graph = {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('loop', 'core.foreach'),
          inputMappings: {
            items: {
              kind: 'literal' as const,
              value: [{ name: 'Ada' }, { name: 'Bob' }],
            },
          },
          structured: {
            kind: 'for_each' as const,
            maxIterations: 2,
            maxConcurrency: 1,
            body: {
              settings: {},
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
              edges: [],
              nodes: [
                {
                  ...node('body', 'core.call'),
                  config: { target: { ...child.pin } },
                  inputMappings: {
                    input: {
                      kind: 'structured_input' as const,
                      port: 'item',
                      path: '$',
                    },
                  },
                },
              ],
            },
          },
        },
        node('finish', 'core.terminate'),
      ],
      edges: [edge('manual', 'loop'), edge('loop', 'finish')],
    };
    const parent = await publishGraph(graph);
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
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
          'select status,result_ref,slot_lent,consumed_at is not null consumed from app.workflow_calls where parent_run_id=$1 order by invocation_key',
          [accepted.runId],
        ),
      ).toEqual([
        {
          status: 'succeeded',
          result_ref: { kind: 'inline', value: 'Ada!' },
          slot_lent: false,
          consumed: true,
        },
        {
          status: 'succeeded',
          result_ref: { kind: 'inline', value: 'Bob!' },
          slot_lent: false,
          consumed: true,
        },
      ]);
      const checkpoint = await fixture.workerQuery<{
        scheduler_state: {
          invocations: { nodeId: string }[];
          loops: { completedPrefix: number }[];
        };
      }>(
        'select scheduler_state from app.run_checkpoints where workflow_run_id=$1',
        [accepted.runId],
      );
      expect(
        checkpoint[0]?.scheduler_state.invocations.some(
          ({ nodeId }) => nodeId === 'body',
        ),
      ).toBe(false);
      expect(checkpoint[0]?.scheduler_state.loops[0]?.completedPrefix).toBe(2);
    } finally {
      await workers.close();
    }
  }, 30_000);
});
