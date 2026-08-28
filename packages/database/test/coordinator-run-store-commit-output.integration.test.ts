import { describe, it, expect } from 'vitest';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  Pool,
  asRuntime,
  checkpoint,
  databaseUrl,
  insertRun,
  randomUUID,
  seedSucceededFact,
  store,
  versionA,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator output commit invariants', () => {
  it('commits a terminal fact only when checkpoint output ownership is exact', async () => {
    const invocationKey = 'terminal/inline';
    const current = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey,
          nodeId: 'inline',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const runId = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    const { attemptId } = await seedSucceededFact(runId, invocationKey, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    const terminalPlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 2,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'succeeded',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: 'inline',
            status: 'succeeded',
            attemptNumber: 1,
            output: { kind: 'inline', attemptId },
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'run.succeeded',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    } as const;
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: terminalPlan,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

    const wrongInlineRun = await insertRun({
      schedulerState: current,
      status: 'running',
    });
    await seedSucceededFact(wrongInlineRun, invocationKey, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: wrongInlineRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          ...terminalPlan,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'succeeded',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'inline',
                status: 'succeeded',
                attemptNumber: 1,
                output: { kind: 'inline', attemptId: randomUUID() },
              },
            ],
          }),
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const immutableRun = await insertRun({});
    const immutableBase = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 3,
    });
    for (const mutatedCheckpoint of [
      { ...immutableBase, engineVersion: 'engine-v2' },
      { ...immutableBase, remainingIterationBudget: 1 },
    ]) {
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId: immutableRun,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 1,
            checkpoint: mutatedCheckpoint,
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }

    const artifactId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/json',1,$4,
             'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceB,
          `workspaces/${workspaceB}/artifacts/${artifactId}`,
          'b'.repeat(64),
        ],
      ),
    );
    const artifactInvocation = 'terminal/artifact';
    const artifactCurrent = checkpoint({
      runStatus: 'running',
      invocations: [
        {
          invocationKey: artifactInvocation,
          nodeId: 'artifact',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    });
    const artifactRun = await insertRun({
      schedulerState: artifactCurrent,
      status: 'running',
    });
    await expect(
      seedSucceededFact(artifactRun, artifactInvocation, {
        schemaVersion: 1,
        kind: 'artifact',
        artifactId,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('waits for artifact invalidation and rejects the now-unavailable checkpoint output', async () => {
    const artifactId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/json',1,$4,
             'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${artifactId}`,
          'c'.repeat(64),
        ],
      ),
    );
    const invocationKey = 'terminal/artifact-race';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'artifact-race',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(runId, invocationKey, {
      schemaVersion: 1,
      kind: 'artifact',
      artifactId,
    });
    const invalidator = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await invalidator.query('begin');
      await invalidator.query(
        "select set_config('app.workspace_id', $1, true)",
        [workspaceA],
      );
      await invalidator.query(
        `update app.artifacts set status='deleting' where id=$1`,
        [artifactId],
      );
      const commit = store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'succeeded',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'artifact-race',
                status: 'succeeded',
                attemptNumber: 1,
                output: { kind: 'artifact', artifactId },
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.succeeded',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      });
      let settled = false;
      void commit.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await invalidator.query('commit');
      await expect(commit).rejects.toBeInstanceOf(
        CoordinatorRunStateCorruptError,
      );
    } finally {
      await invalidator.query('rollback').catch(() => undefined);
      await invalidator.end();
    }
  });

  it('atomically commits exact events, all logical rows, an attempt subset, and IDs-only outbox', async () => {
    const runId = await insertRun({});
    const invocationA = 'version-a/a';
    const invocationB = 'version-a/b';
    const next = checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 5,
      readySet: [invocationB],
      admittedInvocationKeys: [invocationA],
      invocations: [
        {
          invocationKey: invocationA,
          nodeId: 'a',
          status: 'running',
          attemptNumber: 1,
        },
        {
          invocationKey: invocationB,
          nodeId: 'b',
          status: 'ready',
          attemptNumber: 0,
        },
      ],
    });
    const result = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: next,
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 0,
          },
          {
            schemaVersion: 1,
            sequence: 4,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey: invocationB,
            nodeId: 'b',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey: invocationA, nodeId: 'a', sideEffectClass: 'safe' },
          { invocationKey: invocationB, nodeId: 'b', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            invocationKey: invocationA,
            nodeId: 'a',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    expect(result).toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        event_sequences: number[];
        node_count: number;
        attempt_count: number;
        outbox_count: number;
        payload_keys: string[];
        engine_node_events_valid: boolean;
      }>(
        `select
             (select array_agg(sequence order by sequence) from app.run_events where workflow_run_id=$1) event_sequences,
             (select count(*)::int from app.node_runs where workflow_run_id=$1) node_count,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempt_count,
             (select count(*)::int from app.outbox_events where job_name='execute-node-attempt' and payload->>'runId'=$1::text) outbox_count,
             (select array_agg(key order by key) from app.outbox_events, lateral jsonb_object_keys(payload) key where job_name='execute-node-attempt' and payload->>'runId'=$1::text) payload_keys,
             (select count(*)=2 and bool_and(
                payload->>'schemaVersion'='1'
                and payload->>'invocationKey' in ($2,$3)
                and payload->>'nodeId' in ('a','b')
                and (payload->>'attemptNumber')::int =
                  0
                and payload ? 'nodeRunId'
                and not (payload ? 'attemptId')
              ) from app.run_events
              where workflow_run_id=$1 and type='node.ready') engine_node_events_valid`,
        [runId, invocationA, invocationB],
      ),
    );
    expect(proof.rows[0]).toEqual({
      event_sequences: [1, 2, 3, 4],
      node_count: 2,
      attempt_count: 1,
      outbox_count: 1,
      payload_keys: [
        'attemptId',
        'nodeRunId',
        'outboxEventId',
        'runId',
        'schemaVersion',
        'workspaceId',
      ],
      engine_node_events_valid: true,
    });
  });

  it('commits persisted retry facts and admits only database-due retries', async () => {
    for (const due of ['past', 'future'] as const) {
      const invocationKey = `retry/${due}`;
      const dueAt =
        due === 'past'
          ? '2020-01-01T00:00:00.000Z'
          : '2099-01-01T00:00:00.000Z';
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: due,
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
               status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at,wait_kind
             ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'retry_backoff')`,
          [nodeRunId, workspaceA, runId, due, invocationKey, attemptId, dueAt],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,side_effect_class
             ) values ($1,$2,$3,1,'failed','safe')`,
          [attemptId, workspaceA, nodeRunId],
        );
        await client.query(
          `insert into app.run_events
               (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,2,'node.retry_scheduled',$3::jsonb)`,
          [
            workspaceA,
            runId,
            JSON.stringify({
              schemaVersion: 1,
              nodeRunId,
              attemptId,
              dueAt,
            }),
          ],
        );
      });
      const fresh = await store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(fresh).toMatchObject({ kind: 'ready' });
      if (fresh.kind !== 'ready') throw new Error('expected ready state');
      expect(fresh.state.observations).toEqual([
        expect.objectContaining({
          kind: 'wait',
          eventName: 'node.retry_scheduled',
          sequence: 2,
          invocationKey,
          attemptNumber: 1,
          resumeAt: dueAt,
        }),
      ]);
      const waitingCheckpoint = checkpoint({
        revision: 1,
        runStatus: 'waiting',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: due,
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: dueAt,
            waitKind: 'retry_backoff',
          },
        ],
      });
      await expect(
        store.commitAdvancePlan({
          workspaceId: workspaceA,
          runId,
          workflowVersionId: versionA,
          signal: new AbortController().signal,
          plan: {
            expectedRevision: 0,
            expectedNextEventSequence: 2,
            consumedThroughEventSequence: 2,
            checkpoint: waitingCheckpoint,
            events: [
              {
                schemaVersion: 1,
                sequence: 3,
                name: 'run.waiting',
                occurredAt: '2026-08-21T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).resolves.toMatchObject({ kind: 'committed', revision: 1 });

      const afterWaiting = await store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(afterWaiting).toMatchObject({ kind: 'ready' });
      if (afterWaiting.kind !== 'ready')
        throw new Error('expected ready state');
      expect(afterWaiting.state.observations).toEqual(
        due === 'past'
          ? [{ kind: 'due_at', invocationKey, occurredAt: dueAt }]
          : [],
      );

      const retryPlan = {
        expectedRevision: 1,
        expectedNextEventSequence: 4,
        consumedThroughEventSequence: 3,
        checkpoint: checkpoint({
          revision: 2,
          runStatus: 'running',
          nextEventSequence: 5,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: due,
              status: 'running',
              attemptNumber: 2,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 4,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: due,
            attemptNumber: 1,
          },
        ],
        nodeRunAdmissions: [],
        attempts: [
          {
            invocationKey,
            nodeId: due,
            attemptNumber: 2,
            sideEffectClass: 'safe',
          },
        ],
      } as const;
      const retry = store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: retryPlan,
      });
      if (due === 'past')
        await expect(retry).resolves.toMatchObject({
          kind: 'committed',
          revision: 2,
        });
      else
        await expect(retry).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    }
  });

  it('rejects plans that consume terminal or retry facts without applying their semantics', async () => {
    const terminalInvocation = 'ignored/terminal';
    const terminalRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: terminalInvocation,
            nodeId: 'terminal',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(terminalRun, terminalInvocation, {
      schemaVersion: 1,
      kind: 'inline',
      value: { ok: true },
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: terminalRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            invocations: [
              {
                invocationKey: terminalInvocation,
                nodeId: 'terminal',
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
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);

    const retryInvocation = 'ignored/retry';
    const retryRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: retryInvocation,
            nodeId: 'retry',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const dueAt = '2099-01-01T00:00:00.000Z';
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,retry_due_at
           ) values ($1,$2,$3,'retry',$4,'{}','waiting','safe',$5,1,$6)`,
        [nodeRunId, workspaceA, retryRun, retryInvocation, attemptId, dueAt],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'failed','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.retry_scheduled',$3::jsonb)`,
        [
          workspaceA,
          retryRun,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId,
            attemptId,
            dueAt,
          }),
        ],
      );
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: retryRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 3,
            invocations: [
              {
                invocationKey: retryInvocation,
                nodeId: 'retry',
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
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
  });

  it('commits a persisted wait fact using its physical attempt fence', async () => {
    const invocationKey = 'wait/persisted';
    const resumeAt = '2099-01-01T00:00:00.000Z';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'persisted',
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
             status,side_effect_class,current_attempt_id,current_attempt_number,resume_at
           ) values ($1,$2,$3,'persisted',$4,'{}','waiting','safe',$5,1,$6)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, resumeAt],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.waiting',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            schemaVersion: 1,
            nodeRunId,
            attemptId,
            dueAt: resumeAt,
          }),
        ],
      );
    });
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'persisted',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });

  it('persists more than sixty-four due waiting-to-ready recoveries without admitting attempts', async () => {
    const dueAt = '2020-01-01T00:00:00.000Z';
    const invocations = Array.from({ length: 65 }, (_, index) => ({
      invocationKey: `bulk-due/${String(index).padStart(2, '0')}`,
      nodeId: `node-${String(index).padStart(2, '0')}`,
      status: 'waiting' as const,
      attemptNumber: 1,
      resumeAt: dueAt,
    }));
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations,
      }),
      status: 'waiting',
    });
    const physicalNodeIds = invocations.map(() => randomUUID());
    const physicalAttemptIds = invocations.map(() => randomUUID());
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,resume_at
           )
           select physical_id,$1,$2,node_id,invocation_key,'{}','waiting','safe',attempt_id,1,$3
           from unnest($4::uuid[],$5::uuid[],$6::varchar[],$7::varchar[])
             as due(physical_id,attempt_id,invocation_key,node_id)`,
        [
          workspaceA,
          runId,
          dueAt,
          physicalNodeIds,
          physicalAttemptIds,
          invocations.map(({ invocationKey }) => invocationKey),
          invocations.map(({ nodeId }) => nodeId),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           )
           select attempt_id,$1,node_run_id,1,'failed','safe'
           from unnest($2::uuid[],$3::uuid[]) as attempt(attempt_id,node_run_id)`,
        [workspaceA, physicalAttemptIds, physicalNodeIds],
      );
    });
    const events = [
      ...invocations.map((invocation, index) => ({
        schemaVersion: 1 as const,
        sequence: index + 2,
        name: 'node.ready' as const,
        occurredAt: '2026-08-21T00:00:00.000Z',
        invocationKey: invocation.invocationKey,
        nodeId: invocation.nodeId,
        attemptNumber: 1,
      })),
    ];
    await expect(
      store.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 67,
            readySet: invocations.map(({ invocationKey }) => invocationKey),
            invocations: invocations.map((value) => ({
              invocationKey: value.invocationKey,
              nodeId: value.nodeId,
              status: 'ready' as const,
              attemptNumber: value.attemptNumber,
            })),
          }),
          events,
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        due_payloads_valid: boolean;
        new_attempts: number;
        ready: number;
      }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1 and status='ready') ready,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and attempt.attempt_number > 1) new_attempts,
             (select count(*)=65 and bool_and(
                payload->>'schemaVersion'='1'
                and (payload->>'attemptNumber')::int=1
                and payload ? 'nodeRunId' and payload ? 'attemptId'
              ) from app.run_events where workflow_run_id=$1 and type='node.ready') due_payloads_valid`,
        [runId],
      ),
    );
    expect(proof.rows[0]).toEqual({
      ready: 65,
      new_attempts: 0,
      due_payloads_valid: true,
    });
  });
});
