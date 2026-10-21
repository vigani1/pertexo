import { waitForApplicationLock } from '../support/postgres/lock-coordination.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  canonicalJson,
  workspaceVariableValuesSchema,
} from '@pertexo/workflow-model';
import { createCheckpoint } from '@pertexo/workflow-engine';
import type {
  WorkspaceVariableSnapshot,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import { createWorkspaceVariablesStore } from '../../src/variables/store.js';
import {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
} from '../../src/variables/contract.js';
import { WorkspaceAccessDeniedError } from '../../src/tenant-access/errors.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { withWorkspaceTransaction } from '../../src/tenant-access/transactions.js';
import { acceptWorkflowRun } from '../../src/runs/commands/acceptance.js';
import { RunVariableSnapshotUnavailableError } from '../../src/runs/commands/variables.js';
import { createWorkflowRunDatabase } from '../../src/runs/runs.repository.js';
import { createRetentionDatabase } from '../../src/lifecycle/retention.js';
import { admin, createFamily } from '../lifecycle/calls/fixtures.js';
import {
  apiUrl,
  maintenanceUrl,
  userId,
} from '../lifecycle/retention.support.js';
const config = () => parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
const admissionApplication = `variable-admission-${randomUUID()}`;
let store: ReturnType<typeof createWorkspaceVariablesStore>, pool: Pool;
beforeAll(() => {
  store = createWorkspaceVariablesStore(config());
  pool = new Pool({
    connectionString: apiUrl,
    max: 4,
    application_name: admissionApplication,
  });
});
afterAll(async () => {
  await store.close();
  await pool.end();
});
async function fixture() {
  const family = await createFamily({
    parentDays: 0,
    childDays: 0,
    consumed: true,
  });
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')`,
    [family.workspaceId, userId],
  );
  const parent = await admin.query<{ workflow_id: string }>(
    'select workflow_id from app.workflow_versions where id=$1',
    [family.parentVersionId],
  );
  const parentWorkflowId = parent.rows[0]?.workflow_id;
  if (parentWorkflowId === undefined)
    throw new Error('Parent workflow missing');
  return { ...family, parentWorkflowId };
}
const scope = (workspaceId: string) => ({ workspaceId, actorId: userId });
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
async function admit(f: Awaited<ReturnType<typeof fixture>>, key = hash()) {
  return withWorkspaceTransaction(pool, f.workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      initialCheckpoint: createCheckpoint({
        workflowVersionId: f.parentVersionId,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
      keyHash: key,
      requestHash: 'f'.repeat(64),
      scope: `workflow:${f.parentWorkflowId}`,
      operation: 'workflow.run.accept',
      triggerType: 'manual',
      startedBy: userId,
      workflowId: f.parentWorkflowId,
      workflowVersionId: f.parentVersionId,
    }),
  );
}
async function snapshot(runId: string) {
  return (
    await admin.query<{ snapshot: WorkspaceVariableSnapshot | null }>(
      `select case when run.details_purged_at is not null then null else jsonb_build_object(
       'revision',coalesce(run.variable_set_revision,0),'values',case when run.variable_set_revision is null then '{}'::jsonb else variable_set.values_json end) end snapshot
       from app.workflow_runs run left join app.workspace_variable_set_revisions variable_set
         on variable_set.workspace_id=run.workspace_id and variable_set.revision=run.variable_set_revision where run.id=$1`,
      [runId],
    )
  ).rows[0]?.snapshot;
}
it('stores typed current values once, acknowledges exact commands and audits names without values', async () => {
  const f = await fixture();
  expect(await store.read(scope(f.workspaceId))).toEqual({
    revision: 0,
    values: {},
    descriptions: {},
  });
  const values = {
    CURRENCY: 'EUR-sensitive-to-audit',
    ZERO: 0,
    OFF: false,
    EMPTY: '',
  };
  const command = {
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values,
  };
  expect(await store.replace(command)).toEqual({
    revision: 1,
    changed: true,
    replayed: false,
  });
  expect(await store.replace(command)).toEqual({
    revision: 1,
    changed: true,
    replayed: true,
  });
  expect(await store.read(scope(f.workspaceId))).toEqual({
    revision: 1,
    values,
    descriptions: {},
  });
  expect(
    await store.replace({
      ...command,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    }),
  ).toEqual({ revision: 1, changed: false, replayed: false });
  const audits = await admin.query<{ metadata: unknown }>(
    "select metadata from app.audit_events where workspace_id=$1 and action='workspace.variables_changed'",
    [f.workspaceId],
  );
  expect(audits.rows).toHaveLength(1);
  expect(JSON.stringify(audits.rows)).not.toContain('EUR-sensitive-to-audit');
  expect(audits.rows[0]?.metadata).toEqual({
    revision: 1,
    changedNames: ['CURRENCY', 'EMPTY', 'OFF', 'ZERO'],
  });
});
it('lets one concurrent first revision win and refuses stale overwrites', async () => {
  const f = await fixture();
  const save = (value: number) =>
    store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: value },
    });
  const results = await Promise.allSettled([save(1), save(2)]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
    WorkspaceVariablesConflictError,
  );
  const current = await store.read(scope(f.workspaceId));
  expect(current.revision).toBe(1);
  expect([1, 2]).toContain(current.values.RATE);
  await expect(save(3)).rejects.toBeInstanceOf(WorkspaceVariablesConflictError);
});
it('allows member reads but rechecks current write authority, removal and inactive workspace state', async () => {
  const f = await fixture(),
    memberId = randomUUID();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  });
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Variable reader')",
    [memberId, `${memberId}@example.test`],
  );
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
    [f.workspaceId, memberId],
  );
  await store.replace({
    workspaceId: f.workspaceId,
    actorId: memberId,
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { RATE: 2 },
  });
  await admin.query(
    "update app.workspace_memberships set role='builder',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
    [f.workspaceId, memberId],
  );
  expect(
    (await store.read({ workspaceId: f.workspaceId, actorId: memberId })).values
      .RATE,
  ).toBe(2);
  await expect(
    store.replace({
      workspaceId: f.workspaceId,
      actorId: memberId,
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      values: { RATE: 3 },
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await admin.query(
    "update app.workspaces set status='suspended' where id=$1",
    [f.workspaceId],
  );
  expect((await store.read(scope(f.workspaceId))).values.RATE).toBe(2);
  await expect(
    store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      values: { RATE: 3 },
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await admin.query("update app.workspaces set status='active' where id=$1", [
    f.workspaceId,
  ]);
  await admin.query(
    "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
    [f.workspaceId, memberId],
  );
  await expect(
    store.read({ workspaceId: f.workspaceId, actorId: memberId }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
});
it('forces workspace row security even without a caller-supplied filter', async () => {
  const a = await fixture(),
    b = await fixture();
  for (const f of [a, b])
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 1 },
    });
  const rows = await withWorkspaceTransaction(
    pool,
    a.workspaceId,
    (transaction) =>
      transaction.db.execute(
        sql`select workspace_id from app.workspace_variables`,
      ),
  );
  expect(rows.rows).toEqual([{ workspace_id: a.workspaceId }]);
  expect(
    (await pool.query('select workspace_id from app.workspace_variables')).rows,
  ).toEqual([]);
  expect(
    (
      await withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
        transaction.db.execute(
          sql`select workspace_id from app.workspace_variable_set_revisions`,
        ),
      )
    ).rows,
  ).toEqual([{ workspace_id: a.workspaceId }]);
  expect(
    (
      await pool.query(
        'select workspace_id from app.workspace_variable_set_revisions',
      )
    ).rows,
  ).toEqual([]);
  await expect(
    withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
      transaction.db.execute(
        sql`update app.workspace_variable_set_revisions set values_json='{}'::jsonb`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: '42501' } });
  await expect(
    withWorkspaceTransaction(pool, a.workspaceId, (transaction) =>
      transaction.db.execute(
        sql`update app.workspace_variable_set_revisions set descriptions_json='{}'::jsonb`,
      ),
    ),
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});
it.each(['commit', 'rollback'] as const)(
  'captures a coherent set after a concurrent edit %s and preserves exact retries',
  async (finish) => {
    const f = await fixture();
    await store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 10, CURRENCY: 'EUR' },
    });
    const writer = await pool.connect();
    let pending: ReturnType<typeof admit> | undefined;
    try {
      await writer.query('begin');
      await writer.query("select set_config('app.workspace_id',$1,true)", [
        f.workspaceId,
      ]);
      await writer.query(
        `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
      values($1,2,'{"RATE":20,"CURRENCY":"GBP"}')`,
        [f.workspaceId],
      );
      await writer.query(
        'update app.workspace_variables set revision=2 where workspace_id=$1',
        [f.workspaceId],
      );
      const key = hash();
      pending = admit(f, key);
      await waitForApplicationLock(admin, admissionApplication);
      expect((await store.read(scope(f.workspaceId))).values).toEqual({
        RATE: 10,
        CURRENCY: 'EUR',
      });
      await writer.query(finish);
      const first = await pending;
      const revision = finish === 'commit' ? 2 : 1;
      const values =
        finish === 'commit'
          ? { RATE: 20, CURRENCY: 'GBP' }
          : { RATE: 10, CURRENCY: 'EUR' };
      expect(await snapshot(first.runId)).toEqual({ revision, values });
      await store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: randomUUID(),
        expectedRevision: revision,
        values: { RATE: 30, CURRENCY: 'USD' },
      });
      expect((await admit(f, key)).runId).toBe(first.runId);
      expect(await snapshot(first.runId)).toEqual({ revision, values });
      const next = await admit(f);
      expect(await snapshot(next.runId)).toEqual({
        revision: revision + 1,
        values: { RATE: 30, CURRENCY: 'USD' },
      });
    } finally {
      await writer.query('rollback');
      writer.release();
      await pending?.catch(() => undefined);
    }
  },
);
it('full replay retains the source snapshot after edits; logical detail expiry refuses even before cleanup', async () => {
  const f = await fixture();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 10 },
  });
  const source = await admit(f);
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { RATE: 20 },
  });
  const runs = createWorkflowRunDatabase(config());
  try {
    const command = {
      workspaceId: f.workspaceId,
      actorId: userId,
      sourceRunId: source.runId,
      workflowVersionId: f.parentVersionId,
      input: { vars: { RATE: 999 } },
      idempotencyKeyHash: hash(),
      requestHash: hash(),
      scope: `workflow:${f.parentWorkflowId}:replay`,
      checkpointFactory: (version: { id: string }) => ({
        checkpoint: createCheckpoint({
          workflowVersionId: version.id,
          iterationBudget: 200,
          nextEventSequence: 2,
        }),
      }),
    };
    const replay = await runs.replay(command);
    expect(await snapshot(replay.run.id)).toEqual({
      revision: 1,
      values: { RATE: 10 },
    });
    await admin.query(
      "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
      [source.runId],
    );
    expect(await snapshot(source.runId)).not.toBeNull();
    expect(
      await runs.readVariables({
        actorId: userId,
        workspaceId: f.workspaceId,
        runId: source.runId,
      }),
    ).toBeNull();
    await expect(
      runs.replay({
        ...command,
        idempotencyKeyHash: hash(),
        requestHash: hash(),
      }),
    ).rejects.toBeInstanceOf(RunVariableSnapshotUnavailableError);
    const retention = createRetentionDatabase(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
    );
    try {
      await retention.enforce();
      expect(
        (
          await admin.query(
            'select revision from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual([{ revision: 1 }, { revision: 2 }]);
      await admin.query(
        "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
        [replay.run.id],
      );
      await retention.enforce();
      expect(
        (
          await admin.query(
            'select revision from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual([{ revision: 2 }]);
    } finally {
      await retention.close();
    }
    expect(await snapshot(source.runId)).toBeNull();
  } finally {
    await runs.close();
  }
});
it('bounds a no-match expression scan, continues to real references and rejects a changed source cursor', async () => {
  const f = await fixture();
  const workflowId = [f.parentWorkflowId, f.childWorkflowId].sort()[0];
  if (workflowId === undefined) throw new Error('Workflow missing');
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const mappings = Object.fromEntries(
    Array.from({ length: 105 }, (_, index) => [
      `N${String(index).padStart(3, '0')}`,
      {
        kind: 'expression' as const,
        language: 'jsonata' as const,
        expression: '"unrelated"',
      },
    ]),
  );
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        ...node('values', 'core.set'),
        inputMappings: {
          ...mappings,
          currency: { kind: 'workspace_variable', name: 'CURRENCY' },
          optional: {
            kind: 'expression',
            language: 'jsonata',
            expression: '$lookup($vars,runInput.name)',
          },
          literal: { kind: 'literal', value: '$vars.FAKE' },
        },
      },
    ],
    edges: [],
  };
  await admin.query(
    'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
    [f.workspaceId, workflowId, JSON.stringify(graph), userId],
  );
  const first = await store.usage({
    ...scope(f.workspaceId),
    name: 'CURRENCY',
    limit: 25,
  });
  expect(first.items).toEqual([]);
  expect(first.next?.offset).toBe(100);
  if (first.next === null) throw new Error('Expected continuation');
  const next = await store.usage({
    ...scope(f.workspaceId),
    name: 'CURRENCY',
    limit: 25,
    after: first.next,
  });
  expect(next.items.map((item) => item.kind)).toEqual(['direct', 'dynamic']);
  expect(new Set(next.items.map((item) => item.id)).size).toBe(2);
  await admin.query(
    'update app.workflow_drafts set revision=revision+1 where workflow_id=$1',
    [workflowId],
  );
  await expect(
    store.usage({
      ...scope(f.workspaceId),
      name: 'CURRENCY',
      limit: 25,
      after: first.next,
    }),
  ).rejects.toBeInstanceOf(WorkspaceVariableUsageChangedError);
});

it('keeps the fixed empty revision on replay after configuration is first added', async () => {
  const f = await fixture();
  const source = await admit(f);
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 20 },
  });
  const runs = createWorkflowRunDatabase(config());
  try {
    const command = {
      ...scope(f.workspaceId),
      sourceRunId: source.runId,
      workflowVersionId: f.parentVersionId,
      input: {},
      idempotencyKeyHash: hash(),
      requestHash: hash(),
      scope: `workflow:${f.parentWorkflowId}:replay`,
      checkpointFactory: (version: { id: string }) => ({
        checkpoint: createCheckpoint({
          workflowVersionId: version.id,
          iterationBudget: 200,
          nextEventSequence: 2,
        }),
      }),
    };
    const replay = await runs.replay(command);
    expect(await snapshot(replay.run.id)).toEqual({ revision: 0, values: {} });
    expect(
      await runs.readVariables({
        actorId: userId,
        workspaceId: f.workspaceId,
        runId: replay.run.id,
      }),
    ).toEqual({ revision: 0, values: {} });
    expect(await snapshot((await admit(f)).runId)).toEqual({
      revision: 1,
      values: { RATE: 20 },
    });
    await admin.query(
      "update app.workflow_runs set status='succeeded',input_ref=null,input_ref_expires_at=null,created_at=clock_timestamp()-interval '32 days',completed_at=clock_timestamp()-interval '31 days' where id=$1",
      [source.runId],
    );
    await expect(
      runs.replay({
        ...command,
        idempotencyKeyHash: hash(),
        requestHash: hash(),
      }),
    ).rejects.toBeInstanceOf(RunVariableSnapshotUnavailableError);
  } finally {
    await runs.close();
  }
});
it('shares one maximum-size value set across fifty accepted runs', async () => {
  const f = await fixture();
  const values: Record<string, string> = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `TEXT_${String(index)}`,
      Array.from({ length: 4000 }, (_, offset) =>
        String.fromCharCode(97 + ((offset + index) % 26)),
      ).join(''),
    ]),
  );
  let spare = 32768 - Buffer.byteLength(canonicalJson(values));
  for (const key of Object.keys(values)) {
    const add = Math.min(96, spare);
    values[key] = (values[key] ?? '') + 'x'.repeat(add);
    spare -= add;
  }
  expect(Buffer.byteLength(canonicalJson(values))).toBe(32768);
  workspaceVariableValuesSchema.parse(values);
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values,
  });
  const started = performance.now();
  const accepted = [];
  for (let i = 0; i < 50; i += 1) accepted.push(await admit(f));
  expect(
    (
      await admin.query(
        'select count(*)::int n from app.workspace_variable_set_revisions where workspace_id=$1',
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await admin.query(
        'select count(*)::int n,min(variable_set_revision)::int revision,sum(pg_column_size(variable_set_revision))::int reference_bytes from app.workflow_runs where id=any($1::uuid[])',
        [accepted.map((run) => run.runId)],
      )
    ).rows,
  ).toEqual([{ n: 50, revision: 1, reference_bytes: 200 }]);
  for (const run of accepted)
    expect(await snapshot(run.runId)).toEqual({ revision: 1, values });
  console.info(
    `Variable revision qualification: 32,768 canonical bytes, 50 runs, 200 reference bytes, ${String(Math.round(performance.now() - started))}ms.`,
  );
});
