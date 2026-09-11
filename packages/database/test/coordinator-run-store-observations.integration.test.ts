import type { Pool as PgPool, PoolClient } from 'pg';
import { describe, it, expect } from 'vitest';

import {
  CoordinatorRunStateCorruptError,
  Pool,
  asOwner,
  asRuntime,
  checkDatabaseReadiness,
  checkpoint,
  createCoordinatorRunStore,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  randomUUID,
  retainedLegacyInvocationKey,
  retainedLegacyNodeRunId,
  store,
  versionA,
  versionB,
  workerBaseUrl,
  workflowB,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';

type ObservedCoordinatorQuery = Readonly<{
  kind: string;
  values: readonly unknown[];
}>;

function coordinatorQueryKind(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim().toLowerCase();
  if (normalized.includes("current_setting('app.workspace_id'")) {
    return normalized.includes("pg_settings where name='statement_timeout'")
      ? 'verify_workspace_context'
      : 'empty_tenant_context';
  }
  if (normalized === 'begin isolation level repeatable read read only')
    return 'begin_repeatable_read_only';
  if (normalized.includes("set_config('app.workspace_id'"))
    return 'install_workspace_context';
  if (normalized.includes('from app.workflow_runs run'))
    return 'run_checkpoint';
  if (
    normalized.includes('count(*)::int as fact_count') &&
    normalized.includes('from app.run_events')
  )
    return 'fact_capacity';
  if (
    normalized.includes('select event.sequence, event.type') &&
    normalized.includes('from app.run_events event')
  )
    return 'fact_page';
  if (
    normalized.includes('from app.node_attempts attempt') &&
    normalized.includes('attempt.id=any($2::uuid[])')
  )
    return 'fact_physical_attempts';
  if (
    normalized.includes("attempt.retry_decision='pending'") &&
    normalized.includes('from app.node_attempts attempt')
  )
    return 'pending_failures';
  if (
    normalized.includes('from app.node_runs node') &&
    normalized.includes('left join app.node_attempts attempt')
  )
    return 'checkpoint_physical_state';
  if (normalized.includes('coalesce(retry_due_at, resume_at) as due_at'))
    return 'due_wakeups';
  if (normalized === 'commit' || normalized === 'rollback') return normalized;
  return 'unexpected';
}

function queryTextAndValues(arguments_: readonly unknown[]): Readonly<{
  text: string;
  values: readonly unknown[];
}> {
  const request = arguments_[0];
  if (typeof request === 'string')
    return {
      text: request,
      values: Array.isArray(arguments_[1]) ? arguments_[1] : [],
    };
  if (
    typeof request === 'object' &&
    request !== null &&
    'text' in request &&
    typeof request.text === 'string'
  )
    return {
      text: request.text,
      values:
        'values' in request && Array.isArray(request.values)
          ? request.values
          : [],
    };
  throw new Error('Coordinator test observed an unsupported PostgreSQL query');
}

function observedCoordinatorStore(afterQuery?: (kind: string) => void) {
  const originalConnect = Reflect.get(Pool.prototype, 'connect');
  const connectWithPromise = originalConnect as unknown as (
    this: PgPool,
  ) => Promise<PoolClient>;
  const observedQueries: ObservedCoordinatorQuery[] = [];
  let clientsAcquired = 0;
  Pool.prototype.connect = function (
    this: PgPool,
    ...arguments_: unknown[]
  ): unknown {
    if (arguments_.length > 0)
      throw new Error('Coordinator test expected promise-based pool checkout');
    return connectWithPromise.call(this).then((client) => {
      clientsAcquired += 1;
      const originalQuery = client.query.bind(client) as unknown as (
        ...queryArguments: unknown[]
      ) => unknown;
      client.query = ((...queryArguments: unknown[]): unknown => {
        const { text, values } = queryTextAndValues(queryArguments);
        const kind = coordinatorQueryKind(text);
        observedQueries.push({ kind, values });
        const result = originalQuery(...queryArguments);
        if (afterQuery === undefined) return result;
        return Promise.resolve(result).then((value) => {
          afterQuery(kind);
          return value;
        });
      }) as typeof client.query;
      return client;
    });
  } as typeof Pool.prototype.connect;
  const observedStore = createCoordinatorRunStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
  );
  return {
    close: async (): Promise<void> => {
      try {
        await observedStore.close();
      } finally {
        Pool.prototype.connect = originalConnect;
      }
    },
    get clientsAcquired(): number {
      return clientsAcquired;
    },
    observedQueries,
    store: observedStore,
  };
}

function observedKinds(
  queries: readonly ObservedCoordinatorQuery[],
): readonly string[] {
  return queries.map(({ kind }) => kind);
}

describe('Coordinator observation integrity invariants', () => {
  it('preserves legacy invocation keys and admits only canonical engine identities', async () => {
    const retained = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ invocation_key: string }>(
        `select invocation_key from app.node_runs
             where workspace_id=$1 and id=$2`,
        [workspaceA, retainedLegacyNodeRunId],
      ),
    );
    expect(retained.rows).toEqual([
      { invocation_key: retainedLegacyInvocationKey },
    ]);

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

    const readinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    await asOwner(workspaceA, (client) =>
      client.query(
        `alter table app.node_runs
             drop constraint node_runs_invocation_key_format,
             add constraint node_runs_invocation_key_format
               check (length(invocation_key) > 0)`,
      ),
    );
    try {
      await expect(
        checkDatabaseReadiness(readinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow('Coordinator RunStore grants are incompatible');
    } finally {
      await asOwner(workspaceA, (client) =>
        client.query(
          `alter table app.node_runs
               drop constraint node_runs_invocation_key_format,
               add constraint node_runs_invocation_key_format check (
                 invocation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'
                 or invocation_key ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'
               )`,
        ),
      );
    }
    await expect(
      checkDatabaseReadiness(readinessPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({
      migrationHead: '0086_operator_attempt_reclaim_state.sql',
    });
    await readinessPool.end();
  });

  it('loads a valid revision-zero checkpoint at cursor two and enforces workspace RLS', async () => {
    const runId = await insertRun({});
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'ready',
      state: {
        runId,
        workflowVersionId: versionA,
        checkpoint: checkpoint({}),
        completedOutputs: [],
        observations: [],
      },
    });
    const foreignRun = await insertRun({
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
      schedulerState: checkpoint({ workflowVersionId: versionB }),
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: foreignRun,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('retrospectively characterizes the normal observation query sequence on one repeatable-read client', async () => {
    const runId = await insertRun({});
    const observed = observedCoordinatorStore();
    try {
      await expect(
        observed.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'ready' });

      expect(observed.clientsAcquired).toBe(1);
      expect(observedKinds(observed.observedQueries)).toEqual([
        'empty_tenant_context',
        'begin_repeatable_read_only',
        'install_workspace_context',
        'verify_workspace_context',
        'run_checkpoint',
        'fact_capacity',
        'pending_failures',
        'checkpoint_physical_state',
        'due_wakeups',
        'commit',
        'empty_tenant_context',
      ]);
    } finally {
      await observed.close();
    }
  });

  it('retrospectively characterizes 1,000-row observation pagination without extra clients', async () => {
    const runId = await insertRun({});
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.workflow_runs
            set cancel_requested_at=now(), cancel_requested_by='test'
          where workspace_id=$1 and id=$2`,
        [workspaceA, runId],
      ),
    );
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         select $1,$2,sequence,'run.cancel_requested','{"schemaVersion":1}'::jsonb
           from generate_series(2,1002) sequence`,
        [workspaceA, runId],
      );
    });
    const observed = observedCoordinatorStore();
    try {
      const loaded = await observed.store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      });
      expect(loaded).toMatchObject({ kind: 'ready' });
      if (loaded.kind !== 'ready') throw new Error('expected ready state');
      expect(loaded.state.observations).toHaveLength(1_001);
      expect(observed.clientsAcquired).toBe(1);
      expect(observedKinds(observed.observedQueries)).toEqual([
        'empty_tenant_context',
        'begin_repeatable_read_only',
        'install_workspace_context',
        'verify_workspace_context',
        'run_checkpoint',
        'fact_capacity',
        'fact_page',
        'fact_page',
        'pending_failures',
        'checkpoint_physical_state',
        'due_wakeups',
        'commit',
        'empty_tenant_context',
      ]);
      const pages = observed.observedQueries.filter(
        ({ kind }) => kind === 'fact_page',
      );
      expect(pages.map(({ values }) => values[2])).toEqual([2, 1_002]);
      expect(pages.map(({ values }) => values[4])).toEqual([1_000, 1_000]);
    } finally {
      await observed.close();
    }
  });

  it('does not issue observation queries after an early not-found result or checkpoint failure', async () => {
    const missing = observedCoordinatorStore();
    try {
      await expect(
        missing.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: randomUUID(),
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'not_found' });
      expect(missing.clientsAcquired).toBe(1);
      expect(observedKinds(missing.observedQueries)).toEqual([
        'empty_tenant_context',
        'begin_repeatable_read_only',
        'install_workspace_context',
        'verify_workspace_context',
        'run_checkpoint',
        'commit',
        'empty_tenant_context',
      ]);
    } finally {
      await missing.close();
    }

    const corruptRun = await insertRun({
      schedulerState: checkpoint({ workflowVersionId: versionB }),
    });
    const corrupt = observedCoordinatorStore();
    try {
      await expect(
        corrupt.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId: corruptRun,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
      expect(corrupt.clientsAcquired).toBe(1);
      expect(observedKinds(corrupt.observedQueries)).toEqual([
        'empty_tenant_context',
        'begin_repeatable_read_only',
        'install_workspace_context',
        'verify_workspace_context',
        'run_checkpoint',
        'rollback',
        'empty_tenant_context',
      ]);
    } finally {
      await corrupt.close();
    }
  });

  it('stops after the active run query when observation loading is canceled', async () => {
    const runId = await insertRun({});
    const controller = new AbortController();
    const observed = observedCoordinatorStore((kind) => {
      if (kind === 'run_checkpoint')
        controller.abort(new Error('cancel characterized observation load'));
    });
    try {
      await expect(
        observed.store.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(observed.clientsAcquired).toBe(1);
      expect(observedKinds(observed.observedQueries)).toEqual([
        'empty_tenant_context',
        'begin_repeatable_read_only',
        'install_workspace_context',
        'verify_workspace_context',
        'run_checkpoint',
      ]);
    } finally {
      await observed.close();
    }
  });

  it('fails closed when checkpoint invocations diverge from physical node state without new facts', async () => {
    const missingInvocationKey = 'version-a/missing-physical-node';
    const missingRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey: missingInvocationKey,
            nodeId: 'missing-physical-node',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
        readySet: [missingInvocationKey],
      }),
      status: 'running',
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: missingRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const invocationKey = 'version-a/contradictory-physical-node';
    const contradictoryRun = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'contradictory-physical-node',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
        readySet: [invocationKey],
      }),
      status: 'running',
    });
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class
           ) values ($1,$2,$3,'contradictory-physical-node',$4,'{}','pending','safe')`,
        [randomUUID(), workspaceA, contradictoryRun, invocationKey],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: contradictoryRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
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
            schemaVersion: 1,
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
            schemaVersion: 1,
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
            JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
          ],
        );
    });
    const loaded = await store.loadAdvanceState({
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
    expect(loaded.state.completedOutputs).toEqual([
      {
        sequence: 3,
        invocationKey,
        attemptId,
        value: { selectedPort: 'true' },
      },
    ]);
  });

  it('rejects a lone started fact whose physical attempt is terminal', async () => {
    const invocationKey = 'version-a/lone-started';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'lone-started',
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
           ) values ($1,$2,$3,'lone-started',$4,'{}','succeeded','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
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
           values ($1,$2,2,'node.started',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
        ],
      );
    });
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
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
            JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
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

      const loaded = await store.loadAdvanceState({
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
           values ($1,$2,3,'run.cancel_requested','{"schemaVersion":1}')`,
        [workspaceA, gapRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: gapRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const unversionedRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'run.cancel_requested','{}'::jsonb)`,
        [workspaceA, unversionedRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: unversionedRun,
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
            schemaVersion: 1,
            nodeRunId: randomUUID(),
            attemptId: randomUUID(),
          }),
        ],
      ),
    );
    await expect(
      store.loadAdvanceState({
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
             jsonb_build_object('schemaVersion',1,'ignored',repeat('x',100000)))`,
        [workspaceA, oversizedRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: oversizedRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      store.commitAdvancePlan({
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
              schemaVersion: 1,
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

    const aggregateRun = await insertRun({});
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           select $1,$2,sequence,'run.cancel_requested',
                  jsonb_build_object(
                    'schemaVersion',1,'ignored',repeat('x',520000)
                  )
           from generate_series(2,131) sequence`,
        [workspaceA, aggregateRun],
      ),
    );
    await expect(
      store.loadAdvanceState({
        workspaceId: workspaceA,
        runId: aggregateRun,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    await expect(
      store.commitAdvancePlan({
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
              schemaVersion: 1,
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
            schemaVersion: 1,
            nodeRunId: 'not-a-uuid',
            attemptId: 'also-not-a-uuid',
          }),
        ],
      ),
    );

    await expect(
      store.loadAdvanceState({
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
               'schemaVersion',1,'nodeRunId',$3::text,'attemptId',$4::text,
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

    const loaded = await store.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toHaveLength(450);
    expect(loaded.state.observations.at(0)).toMatchObject({ sequence: 2 });
    expect(loaded.state.observations.at(-1)).toMatchObject({ sequence: 451 });

    await expect(
      store.commitAdvancePlan({
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
        nodeValue: { schemaVersion: 1, kind: 'inline', value: { ok: true } },
        attemptValue: {
          schemaVersion: 1,
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
          schemaVersion: 1,
          kind: 'inline',
          value: { side: 'node' },
        },
        attemptValue: {
          schemaVersion: 1,
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
            JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
          ],
        );
      });
      await expect(
        store.loadAdvanceState({
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
        [
          workspaceA,
          runId,
          JSON.stringify({ schemaVersion: 1, nodeRunId, attemptId }),
        ],
      );
    });

    await expect(
      store.loadAdvanceState({
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
    const artifactId = randomUUID();
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
            JSON.stringify({ schemaVersion: 1, kind: 'artifact', artifactId }),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('derives deadline and due observations from durable database truth', async () => {
    const invocationKey = 'version-a/waiting';
    const deadlineAt = new Date(Date.now() + 100).toISOString();
    const dueAt = '2020-01-01T00:01:00.000Z';
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const runId = await insertRun({
      deadlineAt,
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    const loaded = await store.loadAdvanceState({
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
});
