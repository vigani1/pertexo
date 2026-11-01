import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRunAdvanceStore } from '../../../src/runs/advance/store.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { persistCallCompletion } from '../../../src/runs/calls/persist.repository.js';
import { readRunCompletionValues } from '../../../src/runs/advance/load/completion.queries.js';
import { admin, inline, insertHint } from '../../lifecycle/calls/fixtures.js';
import { apiUrl, randomUUID } from '../../lifecycle/retention.support.js';
import { declarationFixture } from './storage-fixtures.js';

let store: ReturnType<typeof createRunAdvanceStore>;
let pool: Pool;
beforeAll(() => {
  store = createRunAdvanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  pool = new Pool({ connectionString: apiUrl, max: 1 });
});
afterAll(async () => {
  await Promise.all([store.close(), pool.end()]);
});
const signal = () => new AbortController().signal;
const declare = async (
  fixture: Awaited<ReturnType<typeof declarationFixture>>,
) =>
  store.advance(
    {
      workspaceId: fixture.workspaceId,
      runId: fixture.parentRunId,
      delivery: fixture.delivery,
      signal: signal(),
    },
    () =>
      Promise.resolve({
        kind: 'transition',
        previous: fixture.previous,
        plan: fixture.plan,
      }),
  );

describe('durable Call declaration and result ownership', () => {
  it('refuses input that fits the JSON value bound but exceeds the stored wrapper bound', async () => {
    const fixture = await declarationFixture('x'.repeat(262_130));
    await declare(fixture);
    expect(
      (
        await admin.query(
          'select status,input_ref,safe_error_code from app.workflow_calls where parent_run_id=$1',
          [fixture.parentRunId],
        )
      ).rows,
    ).toEqual([
      {
        status: 'refused',
        input_ref: null,
        safe_error_code: 'call_input_too_large',
      },
    ]);
  });

  it('persists child completion while the existing parent run is locked by another writer', async () => {
    const fixture = await declarationFixture();
    await declare(fixture);
    const call = (
      await admin.query<{ id: string }>(
        'select id from app.workflow_calls where parent_run_id=$1',
        [fixture.parentRunId],
      )
    ).rows[0];
    if (call === undefined) throw new Error('Call record missing');
    await admin.query(
      "update app.workflow_calls set status='accepted',child_run_id=$2,live_child_run_id=$2 where id=$1",
      [call.id, fixture.childRunId],
    );
    const blocker = new Pool({ connectionString: apiUrl, max: 1 });
    const held = await blocker.connect();
    try {
      await held.query('begin');
      await held.query("select set_config('app.workspace_id',$1,true)", [
        fixture.workspaceId,
      ]);
      await held.query(
        'select id from app.workflow_runs where id=$1 for update',
        [fixture.parentRunId],
      );
      await withTenantScopedClient(
        pool,
        { workspaceId: fixture.workspaceId },
        async (client) => {
          await client.query("set local statement_timeout='2s'");
          await client.query(
            'select id from app.workflow_runs where id=$1 for no key update',
            [fixture.childRunId],
          );
          await persistCallCompletion(client, {
            workspaceId: fixture.workspaceId,
            runId: fixture.childRunId,
            plan: {
              ...fixture.plan,
              callIntents: [],
              runResult: { independent: true },
              checkpoint: {
                ...fixture.plan.checkpoint,
                runStatus: 'succeeded',
              },
              events: [
                {
                  sequence: 1,
                  name: 'run.succeeded',
                  occurredAt: new Date().toISOString(),
                },
              ],
            },
          });
        },
      );
      expect(
        (
          await admin.query(
            'select status from app.workflow_calls where id=$1',
            [call.id],
          )
        ).rows,
      ).toEqual([{ status: 'succeeded' }]);
    } finally {
      await held.query('rollback');
      held.release();
      await blocker.end();
    }
  });

  it('commits the wait, immutable input, deadline and wakeup with the checkpoint, and recovers the same identity', async () => {
    const fixture = await declarationFixture();
    expect((await declare(fixture)).kind).toBe('committed');
    const saved = (
      await admin.query<{
        id: string;
        status: string;
        input_ref: unknown;
        deadline_at: Date;
      }>('select * from app.workflow_calls where parent_run_id=$1', [
        fixture.parentRunId,
      ])
    ).rows[0];
    expect(saved).toMatchObject({
      status: 'pending',
      input_ref: { kind: 'inline', value: { declared: true } },
    });
    expect(saved?.deadline_at).toBeInstanceOf(Date);
    const node = (
      await admin.query(
        'select status,control_kind,output_ref from app.node_runs where id=$1',
        [fixture.nodeRunId],
      )
    ).rows[0] as unknown;
    expect(node).toEqual({
      status: 'waiting',
      control_kind: 'workflow_call',
      output_ref: null,
    });
    const hints = await admin.query(
      'select id from app.outbox_events where aggregate_id=$1',
      [fixture.parentRunId],
    );
    expect(hints.rows).toHaveLength(2);
    expect((await declare(fixture)).kind).toBe('already_committed');
    expect(
      (
        await admin.query(
          'select id from app.workflow_calls where parent_run_id=$1',
          [fixture.parentRunId],
        )
      ).rows,
    ).toEqual([{ id: saved?.id }]);
  });

  it('rolls back the whole parent transition when a declaration rebounds to another attempt', async () => {
    const fixture = await declarationFixture();
    const intent = fixture.plan.callIntents?.[0];
    if (intent === undefined) throw new Error('fixture intent missing');
    fixture.plan = {
      ...fixture.plan,
      callIntents: [
        { ...intent, input: { kind: 'inline', attemptId: randomUUID() } },
      ],
    };
    await expect(declare(fixture)).rejects.toThrow(/invalid/u);
    expect(
      (
        await admin.query(
          'select id from app.workflow_calls where parent_run_id=$1',
          [fixture.parentRunId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          'select revision from app.run_checkpoints where workflow_run_id=$1',
          [fixture.parentRunId],
        )
      ).rows,
    ).toEqual([{ revision: 0 }]);
    expect(
      (
        await admin.query(
          'select id from app.outbox_events where aggregate_id=$1',
          [fixture.parentRunId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('loads the validated child result and consumes its fact through the parent CAS rather than exposing declaration input', async () => {
    const fixture = await declarationFixture({ preparedInput: 'private' });
    await declare(fixture);
    const call = (
      await admin.query<{ id: string }>(
        'select id from app.workflow_calls where parent_run_id=$1',
        [fixture.parentRunId],
      )
    ).rows[0];
    if (call === undefined) throw new Error('fixture call missing');
    await admin.query(
      "update app.workflow_calls set status='accepted',child_run_id=$2,live_child_run_id=$2 where id=$1",
      [call.id, fixture.childRunId],
    );
    await withTenantScopedClient(
      pool,
      { workspaceId: fixture.workspaceId },
      async (client) => {
        await client.query(
          'select id from app.workflow_runs where id=$1 for no key update',
          [fixture.childRunId],
        );
        await persistCallCompletion(client, {
          workspaceId: fixture.workspaceId,
          runId: fixture.childRunId,
          plan: {
            ...fixture.plan,
            callIntents: [],
            runResult: { childResult: 42 },
            checkpoint: { ...fixture.plan.checkpoint, runStatus: 'succeeded' },
            events: [
              {
                sequence: 1,
                name: 'run.succeeded',
                occurredAt: new Date().toISOString(),
              },
            ],
          },
        });
      },
    );
    const outboxEventId = await insertHint(
      fixture.workspaceId,
      fixture.parentRunId,
    );
    const delivery = (
      await admin.query<{ payload_checksum: string }>(
        'select payload_checksum from app.outbox_events where id=$1',
        [outboxEventId],
      )
    ).rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');
    await store.advance(
      {
        workspaceId: fixture.workspaceId,
        runId: fixture.parentRunId,
        delivery: { outboxEventId, payloadChecksum: delivery.payload_checksum },
        signal: signal(),
      },
      (state) => {
        expect(state.callOutcomes).toEqual([
          {
            callId: call.id,
            nodeId: 'call',
            invocationKey: fixture.key,
            status: 'succeeded',
          },
        ]);
        expect(state.hasExecutionSlot).toBe(true);
        return Promise.resolve({
          kind: 'transition' as const,
          previous: fixture.plan.checkpoint,
          plan: {
            ...fixture.plan,
            callIntents: [],
            expectedRevision: 1,
            expectedNextEventSequence: 3,
            consumedThroughEventSequence: 2,
            checkpoint: {
              ...fixture.plan.checkpoint,
              revision: 2,
              nextEventSequence: 4,
              invocations: [
                {
                  nodeId: 'call',
                  invocationKey: fixture.key,
                  status: 'succeeded',
                  attemptNumber: 1,
                  output: { kind: 'call', callId: call.id },
                },
              ],
            },
            events: [
              {
                sequence: 3,
                name: 'node.succeeded',
                nodeId: 'call',
                invocationKey: fixture.key,
                attemptNumber: 1,
                occurredAt: new Date().toISOString(),
              },
            ],
          },
        });
      },
    );
    expect(
      (
        await admin.query('select output_ref from app.node_runs where id=$1', [
          fixture.nodeRunId,
        ])
      ).rows,
    ).toEqual([
      { output_ref: JSON.parse(inline({ childResult: 42 })) as unknown },
    ]);
    await withTenantScopedClient(
      pool,
      { workspaceId: fixture.workspaceId },
      async (client) => {
        const values = await readRunCompletionValues(client, {
          workspaceId: fixture.workspaceId,
          runId: fixture.parentRunId,
          inputRef: null,
          variableSetRevision: null,
          nodeIds: ['call'],
        });
        expect(values.outputs).toEqual([
          {
            nodeId: 'call',
            invocationKey: fixture.key,
            value: { childResult: 42 },
          },
        ]);
      },
    );
    const retained = (
      await admin.query<{ consumed_at: Date }>(
        'select consumed_at from app.workflow_calls where id=$1',
        [call.id],
      )
    ).rows[0];
    expect(retained?.consumed_at).toBeInstanceOf(Date);
  });
});
