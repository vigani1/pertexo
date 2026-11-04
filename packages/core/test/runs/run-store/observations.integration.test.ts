import { describe, it, expect } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  seedSucceededFact,
  ownedDeliveryStore,
  versionA,
  versionB,
  workerBaseUrl,
  workflowA,
  workflowB,
  workspaceA,
  workspaceB,
} from './run-store.fixture.js';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  seedAvailableArtifact,
  measureObservationLoad,
  observedCoordinatorStore,
  observedKinds,
  hasConstraint,
} from './observations.fixture.js';

describe('Coordinator observation integrity invariants', () => {
  it.each([{}, { graph: {} }])(
    'rejects persisted invalid executable control metadata %j',
    async (executableJson) => {
      const workflowVersionId = generatePersistedId();
      const checksum = `wf:sha256:${randomUUID().replaceAll('-', '').repeat(2)}`;
      await asOwner(workspaceA, (client) =>
        client.query(
          `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by
       ) select $1,$2,workflow.id,
           (select coalesce(max(version_number),0)+1 from app.workflow_versions
             where workspace_id=$2 and workflow_id=workflow.id),'{}'::jsonb,$3,$4::jsonb,workflow.created_by
          from app.workflows workflow where workflow.workspace_id=$2 and workflow.id=$5`,
          [
            workflowVersionId,
            workspaceA,
            checksum,
            JSON.stringify(executableJson),
            workflowA,
          ],
        ),
      );
      const runId = await insertRun({ workflowVersionId });
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    },
  );

  it('loads a fresh artifact completion', async () => {
    const invocationKey = 'version-a/fresh-artifact';
    const artifactId = await seedAvailableArtifact();
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'fresh-artifact',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(runId, invocationKey, {
      kind: 'artifact',
      artifactId,
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: {
        observations: [
          { kind: 'outcome', output: { kind: 'artifact', artifactId } },
        ],
      },
    });
  });

  it.each(['deleting', 'deleted'] as const)(
    'fails closed when a fresh completion references a %s artifact',
    async (status) => {
      const invocationKey = `version-a/${status}-artifact`;
      const artifactId = await seedAvailableArtifact();
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: `${status}-artifact`,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      await seedSucceededFact(runId, invocationKey, {
        kind: 'artifact',
        artifactId,
      });
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `update app.artifacts set status='deleting' where id=$1`,
          [artifactId],
        );
        if (status === 'deleted')
          await client.query(
            `update app.artifacts
             set status='deleted',deleted_at=clock_timestamp() where id=$1`,
            [artifactId],
          );
      });

      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    },
  );

  it('admits only canonical engine invocation identities', async () => {
    const runId = await insertRun({});
    const canonicalKey = `${versionA}|manual|b:|i:`;
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class
             ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
          [randomUUID(), workspaceA, runId, canonicalKey],
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class
             ) values ($1,$2,$3,'mapped',$4,'{}'::jsonb,'pending','safe')`,
          [
            randomUUID(),
            workspaceA,
            runId,
            `${versionA}|mapped|b:branch%2Fchild|i:loop%3A1`,
          ],
        ),
      ),
    ).resolves.toBeDefined();

    for (const malformed of [
      `|manual|b:|i:`,
      `${versionA}|manual|b:raw/path|i:`,
      `${versionA}|manual|b:|i:loop%3a1`,
      `${versionA}|manual|b:|i:loop:1`,
      `${versionA}|manual|b:|i:|extra`,
      `${versionA}|mánuál|b:|i:`,
    ]) {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_runs (
                 id,workspace_id,workflow_run_id,node_id,invocation_key,
                 branch_context,status,side_effect_class
               ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
            [randomUUID(), workspaceA, runId, malformed],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('loads a valid revision-zero checkpoint at cursor two and enforces workspace RLS', async () => {
    const runId = await insertRun({});
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'ready',
      state: {
        runId,
        workflowVersionId: versionA,
        occurredAt: expect.any(String) as unknown,
        checkpoint: checkpoint({}),
        completedOutputs: [],
        observations: [],
        hasExecutionSlot: true,
        callOutcomes: [],
        taskOutcomes: [],
        workflow: expect.objectContaining({ id: versionA }) as unknown,
      },
    });
    const foreignRun = await insertRun({
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
      schedulerState: checkpoint({ workflowVersionId: versionB }),
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: foreignRun,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('maps ordered started and terminal facts using exact physical attempt ownership', async () => {
    const invocationKey = 'version-a/manual';
    const state = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'manual',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const runId = await insertRun({ schedulerState: state, status: 'running' });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
           ) values ($1,$2,$3,'manual',$4,'{}','succeeded','safe',$5,1,$6::jsonb)`,
        [
          nodeRunId,
          workspaceA,
          runId,
          invocationKey,
          attemptId,
          JSON.stringify({
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
        [
          attemptId,
          workspaceA,
          nodeRunId,
          JSON.stringify({
            kind: 'inline',
            value: { selectedPort: 'true' },
          }),
        ],
      );
      for (const [sequence, type] of [
        [2, 'node.started'],
        [3, 'node.succeeded'],
      ] as const)
        await client.query(
          `insert into app.run_events
               (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,$3,$4,$5::jsonb)`,
          [
            workspaceA,
            runId,
            sequence,
            type,
            JSON.stringify({ nodeRunId, attemptId }),
          ],
        );
    });
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      expect.objectContaining({
        kind: 'cursor_only',
        eventName: 'node.started',
        sequence: 2,
        invocationKey,
        attemptId,
        attemptNumber: 1,
      }),
      expect.objectContaining({
        kind: 'outcome',
        sequence: 3,
        invocationKey,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      }),
    ]);
    expect(loaded.state.completedOutputs).toEqual([]);
  });

  it.each([1, 1_500, 10_000])(
    'loads %i cursor facts through the bounded public observation window',
    async (factCount) => {
      const invocationKey = 'cursor/boundary';
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: 'boundary',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'boundary',$4,'{}','running','safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'running','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `insert into app.run_events (
             workspace_id,workflow_run_id,sequence,type,payload
           )
           select $1,$2,sequence,
                  case when sequence=2 then 'node.started' else 'node.progress' end,
                  $3::jsonb
           from generate_series(2,$4::int + 1) sequence`,
          [
            workspaceA,
            runId,
            JSON.stringify({ nodeRunId, attemptId }),
            factCount,
          ],
        );
      });
      const plans = await asRuntime(
        workerBaseUrl,
        workspaceA,
        async (client) => {
          await client.query('set local enable_seqscan=off');
          const events = await client.query<Record<'QUERY PLAN', unknown>>(
            `explain (analyze, buffers, costs false, format json)
             select event.sequence,event.type,event.payload,event.created_at
               from app.run_events event
              where event.workspace_id=$1 and event.workflow_run_id=$2
                and event.sequence >= 2
              order by event.sequence
              limit $3`,
            [workspaceA, runId, Math.min(factCount, 1_000)],
          );
          const attempts = await client.query<Record<'QUERY PLAN', unknown>>(
            `explain (analyze, buffers, costs false, format json)
             select attempt.id,node.id
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
              where attempt.workspace_id=$1
                and attempt.id=any($2::uuid[])
                and node.workflow_run_id=$3`,
            [workspaceA, [attemptId], runId],
          );
          return { events: events.rows, attempts: attempts.rows };
        },
      );
      const eventPlan = JSON.stringify(plans.events);
      const attemptPlan = JSON.stringify(plans.attempts);
      expect(eventPlan).toContain('"Relation Name":"run_events"');
      expect(eventPlan).toContain('"Node Type":"Index Scan"');
      expect(attemptPlan).toContain('"Relation Name":"node_attempts"');
      expect(attemptPlan).toContain('"Node Type":"Index Scan"');

      const loaded = await ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(loaded).toMatchObject({ kind: 'ready' });
      if (loaded.kind !== 'ready') throw new Error('expected ready state');
      expect(loaded.state.observations).toHaveLength(factCount);
      expect(loaded.state.observations[0]).toMatchObject({
        kind: 'cursor_only',
        eventName: 'node.started',
        sequence: 2,
        invocationKey,
        attemptNumber: 1,
      });
      expect(loaded.state.observations.at(-1)).toMatchObject({
        kind: 'cursor_only',
        eventName: factCount === 1 ? 'node.started' : 'node.progress',
        sequence: factCount + 1,
        invocationKey,
        attemptNumber: 1,
      });
    },
    30_000,
  );

  it('fails closed for event gaps and corrupt physical event identities', async () => {
    const gapRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,3,'run.cancel_requested','{}')`,
        [workspaceA, gapRun],
      ),
    );
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: gapRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const corruptRun = await insertRun({
      schedulerState: checkpoint({ runStatus: 'running' }),
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          corruptRun,
          JSON.stringify({
            nodeRunId: randomUUID(),
            attemptId: randomUUID(),
          }),
        ],
      ),
    );
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: corruptRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('rejects oversized persisted facts without materializing an oversized batch', async () => {
    const oversizedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'run.cancel_requested',
             jsonb_build_object('ignored',repeat('x',100000)))`,
        [workspaceA, oversizedRun],
      ),
    );
    await expect(
      measureObservationLoad('application_oversized', () =>
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId: oversizedRun,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: oversizedRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 4,
          }),
          events: [
            {
              sequence: 3,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('rejects a large wire population at the canonical per-fact guard', async () => {
    const aggregateRun = await insertRun({});
    const storageBytes = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        await client.query(
          `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           select $1,$2,sequence,'run.cancel_requested',
                  jsonb_build_object(
                    'ignored',repeat('x',520000)
                  )
           from generate_series(2,131) sequence`,
          [workspaceA, aggregateRun],
        );
        const size = await client.query<{ bytes: string }>(
          `select sum(octet_length(payload::text))::bigint bytes
           from app.run_events
           where workspace_id=$1 and workflow_run_id=$2 and sequence >= 2`,
          [workspaceA, aggregateRun],
        );
        return Number(size.rows[0]?.bytes);
      },
    );
    expect(storageBytes).toBeGreaterThan(64 * 1024 * 1024);
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: aggregateRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: aggregateRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 131,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 133,
          }),
          events: [
            {
              sequence: 132,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('fails closed on malformed legacy event identities before UUID joins', async () => {
    const malformedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          malformedRun,
          JSON.stringify({
            nodeRunId: 'not-a-uuid',
            attemptId: 'also-not-a-uuid',
          }),
        ],
      ),
    );

    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: malformedRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('chunk-loads application-valid facts beyond 64 MiB of PostgreSQL text expansion', async () => {
    const invocationKey = 'version-a/exponent-heavy-progress';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId: 'exponent-heavy-progress',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const storageBytes = await asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) => {
        await client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class,current_attempt_id,
               current_attempt_number
             ) values ($1,$2,$3,'exponent-heavy-progress',$4,'{}','running',
                       'safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,side_effect_class
             ) values ($1,$2,$3,1,'running','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `with numbers as (
               select jsonb_agg(1e308::numeric) as value
               from generate_series(1,500)
             )
             insert into app.run_events (
               workspace_id,workflow_run_id,sequence,type,payload
             )
             select $1,$2,sequence,'node.progress',jsonb_build_object(
               'nodeRunId',$3::text,'attemptId',$4::text,
               'numbers',numbers.value
             )
             from generate_series(2,451) sequence cross join numbers`,
          [workspaceA, runId, nodeRunId, attemptId],
        );
        const size = await client.query<{ bytes: string }>(
          `select sum(octet_length(payload::text))::bigint as bytes
             from app.run_events
             where workspace_id=$1 and workflow_run_id=$2 and sequence >= 2`,
          [workspaceA, runId],
        );
        return Number(size.rows[0]?.bytes);
      },
    );
    expect(storageBytes).toBeGreaterThan(64 * 1024 * 1024);

    const observed = observedCoordinatorStore();
    const loaded = await measureObservationLoad('numeric_expansion', () =>
      observed.store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).finally(() => observed.close());
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toHaveLength(450);
    expect(loaded.state.observations.at(0)).toMatchObject({ sequence: 2 });
    expect(loaded.state.observations.at(-1)).toMatchObject({ sequence: 451 });
    expect(
      observedKinds(observed.observedQueries).filter(
        (kind) => kind === 'fact_page',
      ).length,
    ).toBeGreaterThan(1);

    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 451,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 452,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'exponent-heavy-progress',
                status: 'running',
                attemptNumber: 1,
              },
            ],
          }),
          events: [],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });

  it('fails closed for started and terminal physical status or output divergence', async () => {
    for (const variant of [
      {
        name: 'started-status',
        eventType: 'node.started',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'progress-status',
        eventType: 'node.progress',
        nodeStatus: 'failed',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'terminal-status',
        eventType: 'node.succeeded',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: { kind: 'inline', value: { ok: true } },
        attemptValue: {
          kind: 'inline',
          value: { ok: true },
        },
      },
      {
        name: 'terminal-output',
        eventType: 'node.succeeded',
        nodeStatus: 'succeeded',
        attemptStatus: 'succeeded',
        nodeValue: {
          kind: 'inline',
          value: { side: 'node' },
        },
        attemptValue: {
          kind: 'inline',
          value: { side: 'attempt' },
        },
      },
    ] as const) {
      const invocationKey = `physical/${variant.name}`;
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: variant.name,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
               status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
             ) values ($1,$2,$3,$4,$5,'{}',$6,'safe',$7,1,$8::jsonb)`,
          [
            nodeRunId,
            workspaceA,
            runId,
            variant.name,
            invocationKey,
            variant.nodeStatus,
            attemptId,
            variant.nodeValue === null
              ? null
              : JSON.stringify(variant.nodeValue),
          ],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
             ) values ($1,$2,$3,1,$4,'safe',$5::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            variant.attemptStatus,
            variant.attemptValue === null
              ? null
              : JSON.stringify(variant.attemptValue),
          ],
        );
        await client.query(
          `insert into app.run_events
               (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,2,$3,$4::jsonb)`,
          [
            workspaceA,
            runId,
            variant.eventType,
            JSON.stringify({ nodeRunId, attemptId }),
          ],
        );
      });
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    }
  });

  it('fails closed for a terminal fact whose stored output is not a tagged execution value', async () => {
    const invocationKey = 'version-a/corrupt-output';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'corrupt-output',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'corrupt-output',$4,'{}','succeeded','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,'succeeded','safe','{"kind":"inline"}'::jsonb)`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.succeeded',$3::jsonb)`,
        [workspaceA, runId, JSON.stringify({ nodeRunId, attemptId })],
      );
    });

    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });

  it('fails closed when a terminal artifact locator is not available in the run workspace', async () => {
    const invocationKey = 'version-a/artifact';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'artifact',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const artifactId = generatePersistedId();
    expect(artifactId[14]).toBe('7');
    await asRuntime(workerBaseUrl, workspaceB, async (client) => {
      await client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/json',1,$4,
             'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceB,
          `workspaces/${workspaceB}/artifacts/${artifactId}`,
          'a'.repeat(64),
        ],
      );
    });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
            ) values ($1,$2,$3,'artifact',$4,'{}','succeeded','safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
            ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            JSON.stringify({ kind: 'artifact', artifactId }),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('derives deadline and due observations from durable database truth', async () => {
    const invocationKey = 'version-a/waiting';
    const initialDeadlineAt = '2099-01-01T00:00:00.000Z';
    const dueAt = '2020-01-01T00:01:00.000Z';
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const runId = await insertRun({
      deadlineAt: initialDeadlineAt,
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: [
          {
            invocationKey,
            nodeId: 'waiting',
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: dueAt,
            waitKind: 'node_wait',
          },
        ],
      }),
      status: 'waiting',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,resume_at,wait_kind
           ) values ($1,$2,$3,'waiting',$4,'{}','waiting','safe',$5,1,$6,'node_wait')`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, dueAt],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const expired = await asOwner(workspaceA, (client) =>
      client.query<{ deadline_at: Date }>(
        `update app.workflow_runs
         set created_at=clock_timestamp()-interval '2 seconds',
             deadline_at=clock_timestamp()-interval '1 second'
         where workspace_id=$1 and id=$2
         returning deadline_at`,
        [workspaceA, runId],
      ),
    );
    const deadlineAt = expired.rows[0]?.deadline_at.toISOString();
    if (deadlineAt === undefined)
      throw new Error('Controlled database deadline missing');
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      { kind: 'deadline_expired', occurredAt: deadlineAt },
      { kind: 'due_at', invocationKey, occurredAt: dueAt },
    ]);
  });

  it('rejects nullable waiting and deadline marker shapes by exact constraint', async () => {
    const runId = await insertRun({
      schedulerState: checkpoint({ runStatus: 'running' }),
      status: 'running',
    });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
            id,workspace_id,workflow_run_id,node_id,invocation_key,
            branch_context,status,side_effect_class
          ) values($1,$2,$3,'invalid-wait','invalid-wait','{}','waiting','safe')`,
          [randomUUID(), workspaceA, runId],
        ),
      ),
    ).rejects.toSatisfy(hasConstraint('node_runs_wait_state_valid'));

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
            id,workspace_id,workflow_run_id,node_id,invocation_key,
            branch_context,status,side_effect_class,control_kind,due_wakeup_at
          ) values($1,$2,$3,'invalid-due','invalid-due','{}','waiting','safe',
            'for_each_barrier',clock_timestamp())`,
          [randomUUID(), workspaceA, runId],
        ),
      ),
    ).rejects.toSatisfy(hasConstraint('node_runs_due_wakeup_consistent'));

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          'update app.workflow_runs set deadline_wakeup_at=clock_timestamp() where id=$1',
          [runId],
        ),
      ),
    ).rejects.toSatisfy(
      hasConstraint('workflow_runs_deadline_wakeup_consistent'),
    );
  });
});
