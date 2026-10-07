import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { createWorkflowRunDatabase } from '../src/api.js';
import {
  applyCoordinatorCallControl,
  persistCoordinatorCallControls,
} from '../src/execution/coordinator/coordinator-call-controls.js';
import type { ParsedTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  asOwner,
  asRuntime,
  databaseUrl,
  parseDatabaseConfig,
  testDelivery,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';
import {
  acceptNativeFixture,
  activateNativeFixture,
  completeNativePhysical,
  createNativeCoordinatorFixtureStore,
  loadNativePlan,
  nativeDescriptions,
} from './support/native-public-store.fixture.js';

beforeAll(async () => {
  await asAdmin(async (client) => {
    const source = await readFile(
      new URL(
        '../src/platform/readiness-workflow-call.sql.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const query = /const WORKFLOW_CALL_CATALOG_SQL = `([\s\S]*?)`;/u.exec(
      source,
    )?.[1];
    if (!query) throw new Error('Catalog query missing');
    expect(
      (
        await client.query(query, [
          'pertexo_owner',
          'pertexo_worker',
          'pertexo_api',
          'pertexo_maintenance',
          'pertexo_operator',
        ])
      ).rows,
    ).toEqual([
      {
        encode:
          'f6e3b94dbc46059b931ae93defcfc003434e9db247450b6b2f1481d1a2ff5d1a',
      },
    ]);
    await client.query('begin');
    await client.query('set local role pertexo_operator');
    await client.query('select app.set_workflow_calls_enabled(true)');
    await client.query('commit');
  });
  await activateNativeFixture();
}, 60_000);

async function sealedPair() {
  const value = { answer: 42 };
  const template = await acceptNativeFixture({ kind: 'literal', value });
  const declaration = template.executable.envelope.graph.callable;
  if (!declaration) throw new Error('Child declaration missing');
  const parent = await acceptNativeFixture(
    { kind: 'node_output', nodeId: 'call', path: '$' },
    {
      workflowId: template.workflowId,
      versionId: template.versionId,
      checksum: template.executable.checksum,
      callableContractIdentity: workflowCallableContractIdentityV1(declaration),
    },
  );
  const store = createNativeCoordinatorFixtureStore();
  try {
    await store.checkReadiness?.();
    const callees = new Map([[template.versionId, declaration]]);
    for (const revision of [0, 1]) {
      const admitted = await (
        await loadNativePlan(parent, store, revision, undefined, callees)
      ).commit();
      if (admitted.kind !== 'committed' || !admitted.admittedAttempts[0])
        throw new Error('Physical admission missing');
      await completeNativePhysical(
        parent.runId,
        admitted.admittedAttempts[0],
        value,
        revision === 1,
      );
    }
    await (await loadNativePlan(parent, store, 2, undefined, callees)).commit();
    const observed = await loadNativePlan(parent, store, 3, undefined, callees);
    const fact = observed.state.workflowCalls?.facts[0];
    if (fact?.status !== 'admitted') throw new Error('Sealed child missing');
    return { parent, child: { ...template, runId: fact.childRunId }, store };
  } catch (error) {
    await store.close();
    throw error;
  }
}

async function cancel(runId: string) {
  const api = createWorkflowRunDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
    nativeDescriptions.slice(-2),
  );
  try {
    await api.cancel({
      actorId,
      workspaceId: workspaceA,
      runId,
      reason: 'Parent control regression',
    });
  } finally {
    await api.close();
  }
}

async function producerInput(pair: Awaited<ReturnType<typeof sealedPair>>) {
  const delivery = await testDelivery(workspaceA, pair.parent.runId, 3);
  return {
    workspaceId: workspaceA,
    runId: pair.parent.runId,
    delivery,
    plan: {
      expectedRevision: 3,
      workflowCalls: {
        cancelChildren: [
          { childRunId: pair.child.runId, reason: 'cancel_requested' },
        ],
      },
    } as unknown as ParsedTransitionPlan,
  };
}

async function claimProducer(input: Awaited<ReturnType<typeof producerInput>>) {
  await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query(
      `insert into app.inbox_receipts (consumer_name,message_id,workspace_id,payload_checksum)
     values ('workflow-coordinator',$1,$2,$3)`,
      [
        input.delivery.outboxEventId,
        workspaceA,
        input.delivery.payloadChecksum,
      ],
    ),
  );
}

async function childControl(runId: string) {
  return asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ cancel_requested_at: Date | null; audits: number }>(
      `select cancel_requested_at,(select count(*)::int from app.run_events
     where workspace_id=$1 and workflow_run_id=$2 and type='run.cancel_requested') audits
     from app.workflow_runs where workspace_id=$1 and id=$2`,
      [workspaceA, runId],
    ),
  );
}

async function fault(
  table: 'outbox_events' | 'run_events',
  predicate: string,
  operation: () => Promise<void>,
) {
  await asAdmin(async (client) => {
    await client.query(`create function app.test_control_fault() returns trigger language plpgsql as $$
      begin if ${predicate} then raise exception 'control fault injection' using errcode='P0001'; end if; return new; end $$`);
    await client.query(`create trigger zz_test_control_fault before insert on app.${table}
      for each row execute function app.test_control_fault()`);
  });
  try {
    await operation();
  } finally {
    await asAdmin(async (client) => {
      await client.query(`drop trigger zz_test_control_fault on app.${table}`);
      await client.query('drop function app.test_control_fault()');
    });
  }
}

async function poisonLineage(
  child: string,
  change: Readonly<{ root: string; depth: number }>,
) {
  // Disposable-db corruption fixture ONLY. Re-enable the exact immutable
  // trigger before committing; runtime calls never receive bypass privileges.
  await asAdmin(async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        'alter table app.workflow_calls disable trigger native_call_outcome_immutable',
      );
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await client.query(
        'update app.workflow_calls set root_run_id=$1,call_depth=$2 where workspace_id=$3 and child_run_id=$4',
        [change.root, change.depth, workspaceA, child],
      );
      await client.query('set constraints all immediate');
      await client.query(
        'alter table app.workflow_calls enable trigger native_call_outcome_immutable',
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });
}

describe('real parent control producer and child-owned apply', () => {
  it.each(['root', 'depth'] as const)(
    'refuses a poisoned sealed child %s lineage and restores it without effects',
    async (field) => {
      const pair = await sealedPair();
      try {
        await cancel(pair.parent.runId);
        const input = await producerInput(pair);
        await claimProducer(input);
        const delivery = await testDelivery(workspaceA, pair.child.runId, 0);
        const other = await acceptNativeFixture({
          kind: 'literal',
          value: null,
        });
        const outbox = () =>
          asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query<{ id: string }>(
              'select id from app.outbox_events where workspace_id=$1 and aggregate_id=$2 order by id',
              [workspaceA, pair.child.runId],
            ),
          );
        const before = await outbox();
        await poisonLineage(pair.child.runId, {
          root: field === 'root' ? other.runId : pair.parent.runId,
          depth: field === 'depth' ? 2 : 1,
        });
        try {
          await expect(
            asRuntime(workerBaseUrl, workspaceA, (client) =>
              persistCoordinatorCallControls(client, input),
            ),
          ).rejects.toMatchObject({ code: '23514' });
          await expect(
            asRuntime(workerBaseUrl, workspaceA, (client) =>
              applyCoordinatorCallControl(client, {
                workspaceId: workspaceA,
                runId: pair.child.runId,
                delivery,
              }),
            ),
          ).rejects.toMatchObject({ code: '23514' });
          expect((await childControl(pair.child.runId)).rows).toEqual([
            { cancel_requested_at: null, audits: 0 },
          ]);
          expect((await outbox()).rows).toEqual(before.rows);
        } finally {
          await poisonLineage(pair.child.runId, {
            root: pair.parent.runId,
            depth: 1,
          });
        }
        // Restoration is exercised through both real owners, not merely a
        // privileged SELECT that could overlook a still-corrupt edge.
        await asRuntime(workerBaseUrl, workspaceA, (client) =>
          persistCoordinatorCallControls(client, input),
        );
        await expect(
          pair.store.loadAdvanceState({
            workspaceId: workspaceA,
            runId: pair.child.runId,
            delivery,
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({ kind: 'ready' });
        expect((await childControl(pair.child.runId)).rows[0]?.audits).toBe(1);
      } finally {
        await pair.store.close();
      }
    },
  );
  it('pins the repaired source and installed existing-owner worker-only contracts', async () => {
    const source = await readFile(
      new URL('../migrations/0140_workflow_call_controls.sql', import.meta.url),
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'e1b816d4244bd0fc2e5c54e3f92ae2ef2a87a4ae99370764e20164968ca07cef',
    );
    const installed = await asAdmin((client) =>
      client.query(
        `select p.proname,md5(p.prosrc) body,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
       (select jsonb_object_agg(role,has_function_privilege(role,p.oid,'EXECUTE'))
        from unnest(array['pertexo_owner','pertexo_worker','pertexo_api','pertexo_dispatcher',
          'pertexo_maintenance','pertexo_operator','pertexo_lifecycle_command']) role) privileges,
       exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
       from pg_proc p where p.oid=any(array[to_regprocedure('app.apply_workflow_call_control(uuid,jsonb)'),
         to_regprocedure('app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)')]) order by p.proname`,
      ),
    );
    expect(installed.rows).toEqual(
      [
        ['apply_workflow_call_control', '03388ccb0f5bf29b59d5122a6ec0712a'],
        ['propagate_workflow_call_control', '6034670c2e0c760d279ccffa7d04c731'],
      ].map(([proname, body]) => ({
        proname,
        body,
        owner: 'pertexo_owner',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, app, pg_temp', 'row_security=on'],
        privileges: {
          pertexo_owner: true,
          pertexo_worker: true,
          pertexo_api: false,
          pertexo_dispatcher: false,
          pertexo_maintenance: false,
          pertexo_operator: false,
          pertexo_lifecycle_command: false,
        },
        public_execute: false,
      })),
    );
  });
  it('emits an intent without mutating or auditing the child in the parent transaction', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const delivery = await testDelivery(workspaceA, pair.parent.runId, 3);
      const input = {
        workspaceId: workspaceA,
        runId: pair.parent.runId,
        delivery,
        plan: {
          expectedRevision: 3,
          workflowCalls: {
            cancelChildren: [
              { childRunId: pair.child.runId, reason: 'cancel_requested' },
            ],
          },
        } as unknown as ParsedTransitionPlan,
      };
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.inbox_receipts
          (consumer_name,message_id,workspace_id,payload_checksum)
          values ('workflow-coordinator',$1,$2,$3)`,
          [delivery.outboxEventId, workspaceA, delivery.payloadChecksum],
        );
        await persistCoordinatorCallControls(client, input);
        await persistCoordinatorCallControls(client, input);
        const child = await client.query(
          `select cancel_requested_at,
          (select count(*)::int from app.run_events where workspace_id=$1
           and workflow_run_id=$2 and type='run.cancel_requested') audits
          from app.workflow_runs where workspace_id=$1 and id=$2`,
          [workspaceA, pair.child.runId],
        );
        expect(child.rows).toEqual([{ cancel_requested_at: null, audits: 0 }]);
      });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          persistCoordinatorCallControls(client, {
            ...input,
            traceparent:
              '00-11111111111111111111111111111111-2222222222222222-01',
          }),
        ),
      ).rejects.toThrow('Workflow Call control intent conflict');
      const intents = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events where workspace_id=$1
         and aggregate_id=$2 and id=$3`,
          [
            workspaceA,
            pair.child.runId,
            uuidv5(
              JSON.stringify([
                'pertexo.workflow-call-control.v1',
                3,
                pair.child.runId,
                'cancel_requested',
              ]),
              delivery.outboxEventId,
            ),
          ],
        ),
      );
      expect(intents.rows).toHaveLength(1);
      const intent = intents.rows[0];
      if (intent === undefined) throw new Error('Control intent missing');
      const childDelivery = {
        outboxEventId: intent.id,
        payloadChecksum: intent.payload_checksum,
      };
      for (let replay = 0; replay < 2; replay += 1) {
        const loaded = await pair.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: pair.child.runId,
          delivery: childDelivery,
          signal: new AbortController().signal,
        });
        expect(loaded.kind).toBe('ready');
        const own = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `select cancel_requested_by,(select count(*)::int from app.run_events
           where workspace_id=$1 and workflow_run_id=$2 and type='run.cancel_requested') audits
           from app.workflow_runs where workspace_id=$1 and id=$2`,
            [workspaceA, pair.child.runId],
          ),
        );
        expect(own.rows).toEqual([
          {
            cancel_requested_by: `workflow-call:${pair.parent.runId}`,
            audits: 1,
          },
        ]);
      }
    } finally {
      await pair.store.close();
    }
  });
  it('processes the real parent CAS intent and commits the child cancellation through the engine', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const stopped = await loadNativePlan(pair.parent, pair.store, 3);
      expect(stopped.plan.workflowCalls?.cancelChildren).toEqual([
        { childRunId: pair.child.runId, reason: 'cancel_requested' },
      ]);
      await expect(stopped.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 4,
      });
      const intentId = uuidv5(
        JSON.stringify([
          'pertexo.workflow-call-control.v1',
          3,
          pair.child.runId,
          'cancel_requested',
        ]),
        stopped.delivery.outboxEventId,
      );
      const intent = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ payload_checksum: string }>(
          'select payload_checksum from app.outbox_events where workspace_id=$1 and id=$2',
          [workspaceA, intentId],
        ),
      );
      expect(intent.rows).toHaveLength(1);
      const intentChecksum = intent.rows[0]?.payload_checksum;
      if (intentChecksum === undefined)
        throw new Error('Control intent missing');
      await expect(
        pair.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: pair.child.runId,
          delivery: {
            outboxEventId: intentId,
            payloadChecksum: intentChecksum,
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'ready' });
      const stoppedChild = await loadNativePlan(pair.child, pair.store, 0);
      expect(stoppedChild.plan.checkpoint.runStatus).toBe('canceled');
      await expect(stoppedChild.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 1,
      });
      const terminal = await childControl(pair.child.runId);
      expect(terminal.rows[0]?.audits).toBe(1);
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        applyCoordinatorCallControl(client, {
          workspaceId: workspaceA,
          runId: pair.child.runId,
          delivery: {
            outboxEventId: intentId,
            payloadChecksum: intentChecksum,
          },
        }),
      );
      expect((await childControl(pair.child.runId)).rows).toEqual(
        terminal.rows,
      );
    } finally {
      await pair.store.close();
    }
  });

  it('refuses stale revision, wrong child/carrier/checksum and extra delivery fields', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const input = await producerInput(pair);
      await claimProducer(input);
      const invoke = (revision: number, child: string, delivery: unknown) =>
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            'select app.propagate_workflow_call_control($1,$2,$3,$4,$5)',
            [
              pair.parent.runId,
              revision,
              child,
              'cancel_requested',
              JSON.stringify(delivery),
            ],
          ),
        );
      await expect(
        invoke(4, pair.child.runId, input.delivery),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        invoke(3, pair.parent.runId, input.delivery),
      ).rejects.toMatchObject({ code: '22023' });
      const other = await acceptNativeFixture({ kind: 'literal', value: null });
      await expect(
        invoke(3, other.runId, input.delivery),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        invoke(3, pair.child.runId, {
          ...input.delivery,
          payloadChecksum: '0'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        invoke(3, pair.child.runId, {
          ...input.delivery,
          reason: 'cancel_requested',
        }),
      ).rejects.toMatchObject({ code: '22023' });
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          applyCoordinatorCallControl(client, {
            workspaceId: workspaceA,
            runId: pair.child.runId,
            delivery: input.delivery,
          }),
        ),
      ).rejects.toMatchObject({ code: '55000' });
      expect((await childControl(pair.child.runId)).rows).toEqual([
        { cancel_requested_at: null, audits: 0 },
      ]);
    } finally {
      await pair.store.close();
    }
  });

  it('rolls back the parent outbox on insertion failure without any child control or audit', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const input = await producerInput(pair);
      const stopped = await loadNativePlan(pair.parent, pair.store, 3);
      const parentState = () =>
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `select revision,(select count(*)::int from app.run_events where workspace_id=$1
          and workflow_run_id=$2) audits from app.run_checkpoints where workspace_id=$1
          and workflow_run_id=$2`,
            [workspaceA, pair.parent.runId],
          ),
        );
      const before = await parentState();
      const intentId = uuidv5(
        JSON.stringify([
          'pertexo.workflow-call-control.v1',
          3,
          pair.child.runId,
          'cancel_requested',
        ]),
        input.delivery.outboxEventId,
      );
      await fault('outbox_events', `new.id='${intentId}'::uuid`, async () => {
        await expect(stopped.commit()).rejects.toMatchObject({
          cause: { code: 'P0001' },
        });
      });
      expect((await parentState()).rows).toEqual(before.rows);
      expect(
        (
          await asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query(
              `select completed_at from app.inbox_receipts where workspace_id=$1
         and consumer_name='workflow-coordinator' and message_id=$2`,
              [workspaceA, input.delivery.outboxEventId],
            ),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query(
              'select id from app.outbox_events where workspace_id=$1 and id=$2',
              [workspaceA, intentId],
            ),
          )
        ).rows,
      ).toEqual([]);
      expect((await childControl(pair.child.runId)).rows).toEqual([
        { cancel_requested_at: null, audits: 0 },
      ]);
    } finally {
      await pair.store.close();
    }
  });

  it('rolls back child control if its own audit fails, then safely applies on retry', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const delivery = await testDelivery(workspaceA, pair.child.runId, 0);
      const apply = () =>
        pair.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: pair.child.runId,
          delivery,
          signal: new AbortController().signal,
        });
      await fault(
        'run_events',
        `new.workflow_run_id='${pair.child.runId}'::uuid and new.type='run.cancel_requested'`,
        async () => {
          await expect(apply()).rejects.toThrow();
        },
      );
      expect((await childControl(pair.child.runId)).rows).toEqual([
        { cancel_requested_at: null, audits: 0 },
      ]);
      await expect(apply()).resolves.toMatchObject({ kind: 'ready' });
      expect((await childControl(pair.child.runId)).rows[0]?.audits).toBe(1);
      expect(
        (
          await asRuntime(workerBaseUrl, workspaceA, (client) =>
            client.query(
              `select completed_at from app.inbox_receipts where workspace_id=$1
         and consumer_name='workflow-coordinator' and message_id=$2`,
              [workspaceA, delivery.outboxEventId],
            ),
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await pair.store.close();
    }
  });

  it('wakes expired inherited deadlines without manufacturing cancellation', async () => {
    const pair = await sealedPair();
    try {
      // Isolated fixture clock boundary only: no runtime grant or production
      // deadline mutation. Preserve the sealed inherited upper bound.
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.workflow_runs set deadline_at=(select max(created_at)+interval '1 microsecond'
          from app.workflow_runs where workspace_id=$1 and id=any($2::uuid[]))
         where workspace_id=$1 and id=any($2::uuid[])`,
          [workspaceA, [pair.parent.runId, pair.child.runId]],
        ),
      );
      const input = await producerInput(pair);
      input.plan = {
        ...input.plan,
        workflowCalls: {
          ...input.plan.workflowCalls,
          cancelChildren: [
            { childRunId: pair.child.runId, reason: 'deadline_expired' },
          ],
        },
      } as ParsedTransitionPlan;
      await claimProducer(input);
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        persistCoordinatorCallControls(client, input),
      );
      const delivery = await testDelivery(workspaceA, pair.child.runId, 0);
      const applied = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query('select app.apply_workflow_call_control($1,$2) result', [
          pair.child.runId,
          JSON.stringify(delivery),
        ]),
      );
      expect(applied.rows).toEqual([{ result: { kind: 'wake' } }]);
      const stopped = await loadNativePlan(pair.child, pair.store, 0);
      expect(stopped.plan.checkpoint.runStatus).toBe('timed_out');
      expect((await childControl(pair.child.runId)).rows).toEqual([
        { cancel_requested_at: null, audits: 0 },
      ]);
    } finally {
      await pair.store.close();
    }
  });

  it('does not wait for a competing child-row writer while producing the parent intent', async () => {
    const pair = await sealedPair();
    try {
      await cancel(pair.parent.runId);
      const input = await producerInput(pair);
      await claimProducer(input);
      await asOwner(workspaceA, async (holder) => {
        await holder.query(
          'select id from app.workflow_runs where workspace_id=$1 and id=$2 for update',
          [workspaceA, pair.child.runId],
        );
        // The completed lock query is the deterministic barrier, not a sleep.
        await asRuntime(workerBaseUrl, workspaceA, async (producer) => {
          await producer.query("set local statement_timeout='1000ms'");
          await persistCoordinatorCallControls(producer, input);
        });
      });
      expect((await childControl(pair.child.runId)).rows).toEqual([
        { cancel_requested_at: null, audits: 0 },
      ]);
    } finally {
      await pair.store.close();
    }
  });

  it('serializes actual child terminal CAS against the opposing parent control session without a cycle', async () => {
    const pair = await sealedPair();
    let completion:
      | ReturnType<Awaited<ReturnType<typeof loadNativePlan>>['commit']>
      | undefined;
    try {
      await cancel(pair.parent.runId);
      const child = await loadNativePlan(pair.child, pair.store, 0);
      expect(child.plan.checkpoint.runStatus).toBe('canceled');
      const input = await producerInput(pair);
      await claimProducer(input);
      await asRuntime(workerBaseUrl, workspaceA, async (producer) => {
        await producer.query("set local statement_timeout='3000ms'");
        const pid = (
          await producer.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (!pid) throw new Error('Producer PID missing');
        await persistCoordinatorCallControls(producer, input);
        // Parent authority locks are now held. The real child CAS must wait
        // before its own run/checkpoint/effects, not form an inverse lock edge.
        completion = child.commit();
        void completion.catch(() => undefined);
        await asAdmin(async (observer) => {
          for (let pass = 0; pass < 200; pass += 1) {
            const waiting = await observer.query<{ waiting: boolean }>(
              `select exists(select 1 from pg_stat_activity where datname=current_database()
               and $1::integer=any(pg_blocking_pids(pid))) waiting`,
              [pid],
            );
            if (waiting.rows[0]?.waiting) return;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          throw new Error(
            'Child terminal CAS did not reach the parent authority barrier',
          );
        });
      });
      if (!completion) throw new Error('Child completion missing');
      await expect(completion).resolves.toMatchObject({
        kind: 'committed',
        revision: 1,
      });
      expect((await childControl(pair.child.runId)).rows[0]?.audits).toBe(1);
    } finally {
      await completion?.catch(() => undefined);
      await pair.store.close();
    }
  });
});
