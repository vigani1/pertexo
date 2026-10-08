import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { acceptWorkflowRun } from '../src/execution/runs/execution-acceptance.js';
import { assertWorkspaceTenantPurgeChain } from './support/workspace-tenant-purge-chain.js';
import {
  apiDatabase,
  hasPostgresCode,
  installExecutionAcceptanceFixture,
  workerDatabase,
  workspaceA,
  workspaceB,
  waitForDatabaseLock,
  workflowId,
  workflowVersionId,
} from './execution-acceptance.fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  proveLegacyConcurrencyUpgrade,
  readTickets,
  reapConcurrencyReceipts,
  setLimit,
  transitionRun,
  withDispatcher,
  withConcurrencyControls,
  withOwner,
} from './workflow-concurrency-admission.fixtures.js';

installExecutionAcceptanceFixture();

describe('current workflow concurrency and ordered production admission', () => {
  it('persists acceptance tickets once for exact replay and preserves gaps after rollback', async () => {
    const first = await acceptRun();
    const before = await readTickets();
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, first.request),
      ),
    ).resolves.toMatchObject({ runId: first.runId });
    expect(await readTickets()).toEqual(before);
    let rolledBackId: string | undefined;
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        const result = await acceptWorkflowRun(transaction, {
          ...first.request,
          scope: `rollback:${randomUUID()}`,
        });
        rolledBackId = result.runId;
        throw new Error('Intentional admission transaction rollback');
      }),
    ).rejects.toThrow('Intentional admission transaction rollback');
    const second = await acceptRun();
    const tickets = await readTickets();
    expect(tickets.map(({ id }) => id)).toEqual([first.runId, second.runId]);
    expect(tickets.some(({ id }) => id === rolledBackId)).toBe(false);
    const [firstTicket, secondTicket] = tickets;
    if (firstTicket === undefined || secondTicket === undefined)
      throw new Error('Missing committed acceptance tickets');
    expect(BigInt(secondTicket.ticket)).toBeGreaterThan(
      BigInt(firstTicket.ticket),
    );
  });

  it('cap one reserves only the oldest run, counts waits, and releases at terminalization', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const second = await acceptRun();
    const granted = await claimRuns();
    expect(granted.events.map(({ aggregateId }) => aggregateId)).toEqual([
      first.runId,
    ]);
    await publishClaims(granted);
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'waiting');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'running');
    await transitionRun(first.runId, 'succeeded');
    expect(
      (await claimRuns()).events.map(({ aggregateId }) => aggregateId),
    ).toEqual([second.runId]);
  });

  it('cap two refuses reversed first-start delivery without consuming a second slot', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    const firstGrant = await claimRuns();
    await publishClaims(firstGrant);
    const secondGrant = await claimRuns();
    expect(firstGrant.events[0]?.aggregateId).toBe(first.runId);
    expect(secondGrant.events[0]?.aggregateId).toBe(second.runId);
    await publishClaims(secondGrant);
    await expect(transitionRun(second.runId, 'running')).rejects.toSatisfy(
      hasPostgresCode('PTC02'),
    );
    await transitionRun(first.runId, 'running');
    await transitionRun(second.runId, 'running');
    expect(
      await withOwner(
        async (client) =>
          (
            await client.query<{ n: number }>(
              'select * from app.workflow_run_active_admissions',
            )
          ).rowCount,
      ),
    ).toBe(0);
  });

  it('grandfathers committed reservations when lowering a cap and stops new grants', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    const third = await acceptRun();
    const one = await claimRuns();
    await publishClaims(one);
    const two = await claimRuns();
    await publishClaims(two);
    await setLimit(1);
    await transitionRun(first.runId, 'running');
    await transitionRun(second.runId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.runId, 'succeeded');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await setLimit(null);
    expect((await claimRuns()).events[0]?.aggregateId).toBe(third.runId);
  });

  it('enabling a cap does not revoke or reorder null-cap committed reservations', async () => {
    const first = await acceptRun();
    const second = await acceptRun();
    await publishClaims(await claimRuns());
    await publishClaims(await claimRuns());
    await setLimit(1);
    await transitionRun(second.runId, 'running');
    await transitionRun(first.runId, 'running');
    expect(
      await withOwner(
        async (client) =>
          (
            await client.query<{ n: number }>(
              "select count(*)::integer n from app.workflow_runs where status='running'",
            )
          ).rows[0]?.n,
      ),
    ).toBe(2);
  });

  it('uses one current cap across published-version identities and lets unrelated workflows progress', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const blocked = await acceptRun({ workflowVersionId: randomUUID() });
    const otherWorkflow = randomUUID();
    const unrelated = await acceptRun({
      workflowId: otherWorkflow,
      workflowVersionId: randomUUID(),
    });
    await publishClaims(await claimRuns());
    await transitionRun(first.runId, 'running');
    const batch = await claimRuns();
    expect(batch.events.map(({ aggregateId }) => aggregateId)).toEqual([
      unrelated.runId,
    ]);
    expect(
      batch.events.some(({ aggregateId }) => aggregateId === blocked.runId),
    ).toBe(false);
  });

  it('fails closed for an old worker helper and direct queued-to-active writer', async () => {
    await setLimit(1);
    const run = await acceptRun();
    expect(
      await withDispatcher(
        async (client) =>
          (
            await client.query<{ allowed: boolean }>(
              'select app.reserve_workflow_run_active_admission($1,$2,$3) allowed',
              [workspaceA, run.outboxEventId, run.runId],
            )
          ).rows[0]?.allowed,
        false,
      ),
    ).toBe(false);
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.workflow_run_active_capacity_available(${workspaceA},1,${run.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('PTC01'));
    await expect(transitionRun(run.runId, 'running', false)).rejects.toSatisfy(
      hasPostgresCode('PTC01'),
    );
    await publishClaims(await claimRuns());
    await transitionRun(run.runId, 'running');
  });

  it('delivers queued cancellation and deadline terminalization despite full capacity and FIFO', async () => {
    await setLimit(1);
    const active = await acceptRun();
    await publishClaims(await claimRuns());
    await transitionRun(active.runId, 'running');
    await acceptRun(); // Earlier queued work must not hold terminal controls hostage.
    const cancelled = await acceptRun();
    const expired = await acceptRun({
      deadlineAt: new Date(Date.now() + 1_000),
    });
    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
      update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by='concurrency-test'
       where workspace_id=${workspaceA} and id=${cancelled.runId}
    `),
    );
    await withOwner((client) =>
      client.query(
        `select pg_sleep(greatest(0,extract(epoch from(deadline_at-clock_timestamp()))+0.001))
       from app.workflow_runs where id=$1`,
        [expired.runId],
      ),
    );
    const controls = [];
    for (let index = 0; index < 2; index += 1) {
      const batch = await claimRuns();
      controls.push(...batch.events.map(({ aggregateId }) => aggregateId));
      await publishClaims(batch);
    }
    expect(controls.sort()).toEqual([cancelled.runId, expired.runId].sort());
    await expect(transitionRun(cancelled.runId, 'running')).rejects.toSatisfy(
      hasPostgresCode('PTC02'),
    );
    await transitionRun(cancelled.runId, 'canceled');
    await transitionRun(expired.runId, 'failed');
  });

  it('reservation recovery replaces transport identity but retains ticket and capacity exactly once', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await acceptRun();
    const granted = await claimRuns();
    const original = granted.events[0];
    if (original === undefined) throw new Error('Missing initial reservation');
    await publishClaims(granted);
    const tickets = await readTickets();
    await withOwner((client) =>
      client.query(
        "update app.workflow_run_active_admissions set recover_after='-infinity'::timestamptz where workflow_run_id=$1",
        [run.runId],
      ),
    );
    const recovered = await claimRuns();
    expect(recovered.events[0]?.aggregateId).toBe(run.runId);
    expect(recovered.events[0]?.id).not.toBe(original.id);
    expect(await readTickets()).toEqual(tickets);
    await publishClaims(recovered);
    await transitionRun(run.runId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
  });

  it('serializes concurrent grants and policy updates without deadlock or over-admission', async () => {
    await setLimit(1);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => acceptRun()),
    );
    const outcomes = await Promise.all([
      ...Array.from({ length: 4 }, () => claimRuns(1)),
      ...Array.from({ length: 4 }, () => setLimit(1)),
    ]);
    const grants = outcomes.flatMap((outcome) => outcome?.events ?? []);
    expect(grants).toHaveLength(1);
    expect(runs.some(({ runId }) => runId === grants[0]?.aggregateId)).toBe(
      true,
    );
    const tickets = await readTickets();
    expect(grants[0]?.aggregateId).toBe(tickets[0]?.id);
  });

  it('enforces shared workspace occupancy as well as each workflow cap', async () => {
    const runs = [];
    for (let index = 0; index < 6; index += 1) {
      const workflowId = randomUUID();
      await setLimit(1, workflowId);
      runs.push(
        await acceptRun({ workflowId, workflowVersionId: randomUUID() }),
      );
    }
    const claims = [];
    for (let index = 0; index < 5; index += 1) {
      const batch = await claimRuns();
      claims.push(...batch.events);
      await publishClaims(batch);
    }
    expect(claims).toHaveLength(5);
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    const first = claims[0];
    if (first === undefined) throw new Error('Missing reserved workspace slot');
    await transitionRun(first.aggregateId, 'running');
    await expect(claimRuns()).resolves.toMatchObject({ events: [] });
    await transitionRun(first.aggregateId, 'succeeded');
    const remaining = await claimRuns();
    expect(remaining.events).toHaveLength(1);
    expect(
      runs.some(({ runId }) => runId === remaining.events[0]?.aggregateId),
    ).toBe(true);
  });

  it('denies direct policy mutation and dispatcher-only reservation from API and worker roles', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.reserve_workflow_run_active_admission(${workspaceA},${run.outboxEventId},${run.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
    for (const database of [apiDatabase, workerDatabase]) {
      await expect(
        database.withWorkspace(workspaceA, ({ db }) =>
          db.execute(sql`
        update app.workflow_concurrency_policies set active_run_limit=null
         where workspace_id=${workspaceA}
      `),
        ),
      ).rejects.toSatisfy(hasPostgresCode('42501'));
    }
  });

  it('skips an exclusively locked run before taking the counter and grants it after lock release', async () => {
    await setLimit(1);
    const run = await acceptRun();
    await withOwner(async (client) => {
      await client.query(
        'select id from app.workflow_runs where workspace_id=$1 and id=$2 for update',
        [workspaceA, run.runId],
      );
      // The pre-counter KEY SHARE SKIP LOCKED step must not wait for this
      // simulated old-worker lock while holding the workspace counter.
      await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      await setLimit(1);
    });
    expect((await claimRuns()).events[0]?.aggregateId).toBe(run.runId);
  }, 5_000);

  it('uses bounded active and FIFO indexes with retained terminal history', async () => {
    await setLimit(2);
    const first = await acceptRun();
    const second = await acceptRun();
    await withOwner(async (client) => {
      // Bulk historical setup is outside the production behavior under test;
      // explicit valid tickets avoid quadratic per-insert reconciliation.
      await client.query('alter table app.workflow_runs disable trigger user');
      await client.query(
        'alter table app.workflow_runs no force row level security',
      );
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,
          trigger_type,status,execution_entitlement_version,admission_ticket)
         select gen_random_uuid(),workspace_id,workflow_id,workflow_version_id,
          'manual','succeeded',execution_entitlement_version,
          nextval('app.workflow_run_admission_ticket_seq')
         from app.workflow_runs cross join generate_series(1,2000)
         where id=$1`,
        [first.runId],
      );
      await client.query('alter table app.workflow_runs enable trigger user');
      await client.query(
        'alter table app.workflow_runs force row level security',
      );
      await client.query('analyze app.workflow_runs');
      const run = await client.query<{
        workflow_id: string;
        admission_ticket: string;
      }>(
        'select workflow_id,admission_ticket::text from app.workflow_runs where id=$1',
        [second.runId],
      );
      const identity = run.rows[0];
      if (identity === undefined)
        throw new Error('Missing indexed fixture identity');
      const active = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) select count(*) from app.workflow_runs
         where workspace_id=$1 and workflow_id=$2 and status in ('running','waiting')`,
        [workspaceA, identity.workflow_id],
      );
      const queued = await client.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) select id from app.workflow_runs
         where workspace_id=$1 and workflow_id=$2 and status='queued'
          and admission_ticket<$3`,
        [workspaceA, identity.workflow_id, identity.admission_ticket],
      );
      expect(JSON.stringify(active.rows)).toContain(
        'workflow_runs_workflow_active_idx',
      );
      expect(JSON.stringify(queued.rows)).toContain(
        'workflow_runs_queued_admission_order_idx',
      );
    });
  });

  it('records authoritative enforcement function fingerprints', async () => {
    const fingerprints = await withOwner(
      async (client) =>
        (
          await client.query<{ name: string; hash: string }>(
            `select proname name,md5(prosrc) hash from pg_proc
         where pronamespace='app'::regnamespace and proname in
          ('enforce_workflow_run_admission','workflow_concurrency_admissible',
           'workflow_run_active_capacity_available','workflow_run_active_admission_eligible',
           'reserve_workflow_run_active_admission','workflow_concurrency_control',
           'workflow_run_admission_blockers','rebind_workflow_run_active_admission') order by proname`,
          )
        ).rows,
    );
    expect(fingerprints).toEqual([
      {
        name: 'enforce_workflow_run_admission',
        hash: '4a178a6940d2a28eb9afde6f5227fbaf',
      },
      {
        name: 'rebind_workflow_run_active_admission',
        hash: '8ff6b3bf9c4140076f4a16b80f0949a3',
      },
      {
        name: 'reserve_workflow_run_active_admission',
        hash: 'e11cf9af2c42e62f995138c7483fe162',
      },
      {
        name: 'workflow_concurrency_admissible',
        hash: '3c541c79eb4d3849b58d8c76a2c5fade',
      },
      {
        name: 'workflow_concurrency_control',
        hash: 'f37e4d9d93e59b518d37713078575eda',
      },
      {
        name: 'workflow_run_active_admission_eligible',
        hash: '9aa4c431740581a37d4873d0e49cc567',
      },
      {
        name: 'workflow_run_active_capacity_available',
        hash: '66e1c3ed4d6d458c4889799733c11063',
      },
      {
        name: 'workflow_run_admission_blockers',
        hash: 'f0127382f587223639b4bfb02f120ee8',
      },
    ]);
  });

  it('upgrades legacy queued ordering and reservations from 0126', async () => {
    await proveLegacyConcurrencyUpgrade();
  }, 30_000);

  it('projects current timestamped blockers without labeling every queued run workflow-limited', async () => {
    await setLimit(1);
    const first = await acceptRun();
    const second = await acceptRun();
    await publishClaims(await claimRuns());
    const projection = () =>
      withOwner(
        async (client) =>
          (
            await client.query<{
              value: { asOf: string; reasons: string[] } | null;
            }>('select app.workflow_run_admission_blockers($1,$2) value', [
              workspaceA,
              second.runId,
            ])
          ).rows[0]?.value,
      );
    expect(await projection()).toMatchObject({
      reasons: ['workflow_capacity', 'workflow_order'],
    });
    await transitionRun(first.runId, 'running');
    const activeBlocker = await projection();
    expect(activeBlocker?.reasons).toEqual(['workflow_capacity']);
    expect(activeBlocker?.asOf).toMatch(/\.\d{6}Z$/u);
    await setLimit(null);
    expect(await projection()).toMatchObject({ reasons: [] });
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.workflow_run_admission_blockers(${workspaceB},${second.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
      select app.workflow_run_admission_blockers(${workspaceA},${second.runId})
    `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('skips a workspace lifecycle lock before grants while settings wait without holding the counter', async () => {
    await setLimit(1);
    const run = await acceptRun();
    let settings: Promise<void> | undefined;
    try {
      await withOwner(async (client) => {
        await client.query(
          'select id from app.workspaces where id=$1 for update',
          [workspaceA],
        );
        const pid = (
          await client.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined)
          throw new Error('Missing workspace lock owner PID');
        settings = setLimit(1);
        await waitForDatabaseLock(pid);
        await expect(claimRuns()).resolves.toMatchObject({ events: [] });
      });
      await settings;
      expect((await claimRuns()).events[0]?.aggregateId).toBe(run.runId);
    } finally {
      await settings?.catch(() => undefined);
    }
  }, 5_000);

  it('rejects direct active inserts for capped workflows, including protocol-aware writers', async () => {
    await setLimit(1);
    for (const database of [apiDatabase, workerDatabase]) {
      for (const protocol of [false, true]) {
        await expect(
          database.withWorkspace(workspaceA, async ({ db }) => {
            if (protocol)
              await db.execute(
                sql`select set_config('app.workflow_concurrency_protocol','1',true)`,
              );
            await db.execute(sql`insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
            values(${randomUUID()},${workspaceA},${workflowId},${workflowVersionId},'api','running')`);
          }),
        ).rejects.toSatisfy(hasPostgresCode(protocol ? 'PTC02' : 'PTC01'));
      }
    }
    expect(await readTickets()).toEqual([]);
  });

  it('serializes authenticated policy CAS with acceptance and grants and replays the exact audit result', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      const auditRequestIds = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ] as const;
      const command = {
        ...scope,
        limit: 1,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        requestId: auditRequestIds[0],
      };
      const [changed] = await Promise.all([
        controls.updateSettings(command),
        ...Array.from({ length: 4 }, () => acceptRun()),
      ]);
      expect(changed.settings).toMatchObject({
        limit: 1,
        revision: 2,
        overflow: 'queue',
      });
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => claimRuns(1)),
      );
      expect(claims.flatMap(({ events }) => events)).toHaveLength(1);
      const replay = await controls.updateSettings(command);
      expect(replay).toEqual({ ...changed, replayed: true });
      const conflicts = await Promise.allSettled([
        controls.updateSettings({
          ...scope,
          limit: 2,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
          requestId: auditRequestIds[1],
        }),
        controls.updateSettings({
          ...scope,
          limit: 3,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
          requestId: auditRequestIds[2],
        }),
        claimRuns(1),
      ]);
      expect(
        conflicts.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const rejected = conflicts.find((result) => result.status === 'rejected');
      expect(
        rejected?.status === 'rejected' ? rejected.reason : undefined,
      ).toMatchObject({
        name: 'WorkflowConcurrencyRevisionConflictError',
        currentRevision: 3,
      });
      expect(
        await withOwner(
          async (client) =>
            (
              await client.query<{ n: number }>(
                "select count(*)::int n from app.audit_events where workspace_id=$1 and action='workflow.concurrency_settings_changed' and request_id=any($2::text[])",
                [workspaceA, auditRequestIds],
              )
            ).rows[0]?.n,
        ),
      ).toBe(2);
    });
  });

  it('bounds positive settings by active current entitlement but permits exact replay and removal after suspension', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 6,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyLimitExceededError',
        maximum: 5,
      });
      const command = {
        ...scope,
        limit: 4,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      };
      const original = await controls.updateSettings(command);
      await withOwner(async (client) => {
        await client.query(
          `insert into app.workspace_execution_entitlement_versions
          (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
          values($1,2,'suspended',1,100,'-infinity'::timestamptz)`,
          [workspaceA],
        );
        await client.query(
          'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
          [workspaceA],
        );
      });
      expect(await controls.readSettings(scope)).toMatchObject({
        limit: 4,
        revision: 2,
        workspaceActiveRunLimit: null,
        workspacePolicyState: 'suspended',
      });
      expect(await controls.updateSettings(command)).toEqual({
        ...original,
        replayed: true,
      });
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 1,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyLimitUnavailableError',
      });
      expect(
        await controls.updateSettings({
          ...scope,
          limit: null,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).toMatchObject({
        settings: {
          limit: null,
          revision: 3,
          workspacePolicyState: 'suspended',
        },
        replayed: false,
      });
    });
  });

  it('expires command receipts after twenty-four hours and reaps only expired rows in bounded existing retention', async () => {
    await withConcurrencyControls(async (controls, scope) => {
      const expiredKey = randomUUID(),
        retainedKey = randomUUID();
      const expiredHash = createHash('sha256').update(expiredKey).digest('hex');
      const retainedHash = createHash('sha256')
        .update(retainedKey)
        .digest('hex');
      await controls.updateSettings({
        ...scope,
        limit: 1,
        expectedRevision: 1,
        idempotencyKey: expiredKey,
      });
      await controls.updateSettings({
        ...scope,
        limit: 2,
        expectedRevision: 2,
        idempotencyKey: retainedKey,
      });
      await withOwner(async (client) => {
        const expiries = await client.query<{ seconds: number }>(
          `select extract(epoch from(expires_at-clock_timestamp()))::float8 seconds
           from app.workflow_concurrency_command_receipts where workspace_id=$1 and key_hash=any($2::text[])`,
          [workspaceA, [expiredHash, retainedHash]],
        );
        expect(expiries.rows).toHaveLength(2);
        for (const { seconds } of expiries.rows)
          expect(seconds).toBeGreaterThan(86_390);
        await client.query(
          `update app.workflow_concurrency_command_receipts
          set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and key_hash=$2`,
          [workspaceA, expiredHash],
        );
        const purge = await assertWorkspaceTenantPurgeChain(client);
        expect(purge).toContain(
          'RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_input_cases',
        );
        expect(purge).toContain("'workflow_concurrency_policies'");
        expect(purge).toContain("'workflow_concurrency_command_receipts'");
      });
      expect(await reapConcurrencyReceipts(1)).toBe(1);
      expect(
        await withOwner(
          async (client) =>
            (
              await client.query<{ key_hash: string }>(
                'select key_hash from app.workflow_concurrency_command_receipts where workspace_id=$1 and key_hash=any($2::text[])',
                [workspaceA, [expiredHash, retainedHash]],
              )
            ).rows,
        ),
      ).toEqual([{ key_hash: retainedHash }]);
      await expect(
        controls.updateSettings({
          ...scope,
          limit: 1,
          expectedRevision: 1,
          idempotencyKey: expiredKey,
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowConcurrencyRevisionConflictError',
        currentRevision: 3,
      });
    });
  });
});
