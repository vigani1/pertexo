import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createGovernanceStore } from '../../src/governance/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  apiUrl,
  actorId,
  workspaceId,
  queryAsOwner,
} from '../support/workflow-authoring.js';
const scope = () => ({ actorId, workspaceId });
let store: ReturnType<typeof createGovernanceStore>;
beforeAll(() => {
  store = createGovernanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
});
afterAll(() => store.close());
async function insert(count = 1) {
  const targetId = randomUUID();
  await queryAsOwner(
    `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata,occurred_at) select gen_random_uuid(),$1,$2,'audit.test','workflow',$3,$4::jsonb,'2026-10-16T10:00:00.123456Z'::timestamptz from generate_series(1,$5)`,
    [
      workspaceId,
      actorId,
      targetId,
      JSON.stringify({
        revision: 2,
        providerMessage: 'SECRET',
        values: { password: 'SECRET' },
        workflowId: targetId,
        secretVersionId: 'SECRET',
      }),
      count,
    ],
    workspaceId,
  );
  return targetId;
}
it('filters and paginates timestamp ties without leaking arbitrary legacy metadata', async () => {
  const targetId = await insert(3);
  const first = await store.list({ ...scope(), query: { targetId, limit: 2 } });
  expect(first.items).toHaveLength(2);
  expect(first.items[0]?.metadata).toEqual({
    revision: 2,
    workflowId: targetId,
  });
  expect(JSON.stringify(first)).not.toContain('SECRET');
  const second = await store.list({
    ...scope(),
    query: { targetId, limit: 2, after: first.nextCursor ?? '' },
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.items, ...second.items].map((row) => row.id)).size,
  ).toBe(3);
  expect(
    (
      await store.list({
        ...scope(),
        query: { targetId, action: 'another.action', limit: 50 },
      })
    ).items,
  ).toHaveLength(0);
  expect(
    (
      await store.list({
        ...scope(),
        query: { targetId, from: '2026-10-16T10:00:00.124Z', limit: 50 },
      })
    ).items,
  ).toHaveLength(0);
  await expect(
    store.list({ ...scope(), query: { after: 'garbage', limit: 1 } }),
  ).rejects.toThrow('cursor');
});
it('keeps a one-client pool available while an audit CSV consumer is blocked', async () => {
  const targetId = await insert(600);
  const opened = Promise.withResolvers<undefined>(),
    release = Promise.withResolvers<undefined>();
  const exporting = store.exportCsv({
    ...scope(),
    query: { targetId },
    consume: async (csv) => {
      let rows = 0;
      for await (const chunk of csv) {
        if (rows === 1) {
          opened.resolve(undefined);
          await release.promise;
        }
        expect(chunk).not.toContain('SECRET');
        rows += 1;
      }
      expect(rows).toBe(601);
    },
  });
  const timeout = setTimeout(() => {
    opened.reject(new Error('export retained the only client'));
  }, 5000);
  try {
    await opened.promise;
    expect(
      (await store.settings({ ...scope(), signal: AbortSignal.timeout(3000) }))
        .auditRetentionDays,
    ).toBeGreaterThanOrEqual(30);
  } finally {
    clearTimeout(timeout);
    release.resolve(undefined);
    await exporting;
  }
});
it('records settings once, rejects stale saves and applies workspace retention bounds', async () => {
  const initial = await store.settings(scope());
  const command = {
    ...scope(),
    expectedRevision: initial.revision,
    auditRetentionDays: 30,
    idempotencyKey: randomUUID(),
  };
  const result = await store.configure(command);
  expect(await store.configure(command)).toEqual(result);
  await expect(
    store.configure({ ...command, idempotencyKey: randomUUID() }),
  ).rejects.toThrow('changed');
  const facts = await queryAsOwner<{ count: string }>(
    "select count(*) from app.audit_events where workspace_id=$1 and action='workspace.governance_changed' and metadata->>'revision'=$2",
    [workspaceId, String(result.revision)],
    workspaceId,
  );
  expect(facts[0]?.count).toBe('1');
  await expect(
    queryAsOwner(
      'update app.workspaces set audit_retention_days=29 where id=$1',
      [workspaceId],
      workspaceId,
    ),
  ).rejects.toMatchObject({ constraint: 'workspaces_audit_retention_valid' });
  await store.configure({
    ...scope(),
    expectedRevision: result.revision,
    auditRetentionDays: initial.auditRetentionDays,
    idempotencyKey: randomUUID(),
  });
});
it('does not reveal another workspace or admit an inactive/non-admin actor', async () => {
  await expect(
    store.list({ ...scope(), workspaceId: randomUUID(), query: { limit: 1 } }),
  ).rejects.toThrow('unavailable');
  await expect(
    store.settings({ ...scope(), actorId: randomUUID() }),
  ).rejects.toThrow('unavailable');
});

it('refuses a builder, admits a current admin, then fences a demotion during export', async () => {
  const { identity } = await import('../support/workflow-authoring.js');
  const userId = randomUUID();
  await identity.createUser({
    id: userId,
    email: `audit-${userId}@example.test`,
    displayName: '=SUM(1,1)',
  });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
    [workspaceId, userId],
    workspaceId,
  );
  const memberScope = { workspaceId, actorId: userId };
  await expect(store.settings(memberScope)).rejects.toThrow('unavailable');
  await queryAsOwner(
    "update app.workspace_memberships set role='admin' where workspace_id=$1 and user_id=$2",
    [workspaceId, userId],
    workspaceId,
  );
  expect(
    (await store.settings(memberScope)).auditRetentionDays,
  ).toBeGreaterThanOrEqual(30);
  const targetId = await insert(600);
  await expect(
    store.exportCsv({
      ...memberScope,
      query: { targetId },
      consume: async (csv) => {
        let rows = 0;
        for await (const _chunk of csv) {
          if (++rows === 2)
            await queryAsOwner(
              "update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2",
              [workspaceId, userId],
              workspaceId,
            );
        }
      },
    }),
  ).rejects.toThrow('unavailable');
});

it('applies configured audit retention through the maintenance runner', async () => {
  const { dispatcherUrl } = await import('../support/workflow-authoring.js');
  const { enforceRetention } = await import('../support/retention.js');
  const initial = await store.settings(scope());
  const settings = await store.configure({
    ...scope(),
    expectedRevision: initial.revision,
    auditRetentionDays: 30,
    idempotencyKey: randomUUID(),
  });
  const old = randomUUID(),
    recent = randomUUID();
  await queryAsOwner(
    "insert into app.audit_events(id,workspace_id,action,target_type,occurred_at) values($1,$3,'audit.retention','workspace',clock_timestamp()-interval '31 days'),($2,$3,'audit.retention','workspace',clock_timestamp()-interval '29 days')",
    [old, recent, workspaceId],
    workspaceId,
  );
  await enforceRetention(dispatcherUrl);
  const remaining = await queryAsOwner<{ id: string }>(
    'select id from app.audit_events where workspace_id=$1 and id=any($2::uuid[])',
    [workspaceId, [old, recent]],
    workspaceId,
  );
  expect(remaining.map((row) => row.id)).toEqual([recent]);
  await store.configure({
    ...scope(),
    expectedRevision: settings.revision,
    auditRetentionDays: initial.auditRetentionDays,
    idempotencyKey: randomUUID(),
  });
});

it('refuses more than 100,000 matching events before starting the download', async () => {
  const targetId = await insert(100001);
  let started = false;
  await expect(
    store.exportCsv({
      ...scope(),
      query: { targetId },
      consume: () => {
        started = true;
        return Promise.resolve();
      },
    }),
  ).rejects.toThrow('narrower date range');
  expect(started).toBe(false);
});

it('escapes spreadsheet formulas in actor names and keeps payloads out of CSV', async () => {
  const { identity } = await import('../support/workflow-authoring.js');
  const actor = randomUUID(),
    targetId = randomUUID();
  await identity.createUser({
    id: actor,
    email: `csv-${actor}@example.test`,
    displayName: '=SUM(1,1)',
  });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
    [workspaceId, actor],
    workspaceId,
  );
  await queryAsOwner(
    "insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,metadata) values($1,$2,$3,'audit.csv','workflow',$4,$5::jsonb)",
    [
      randomUUID(),
      workspaceId,
      actor,
      targetId,
      JSON.stringify({ password: 'SECRET', revision: 2 }),
    ],
    workspaceId,
  );
  let result = '';
  await store.exportCsv({
    ...scope(),
    query: { targetId },
    consume: async (csv) => {
      for await (const row of csv) result += row;
    },
  });
  expect(result).toContain('"\'=SUM(1,1)"');
  expect(result).not.toContain('SECRET');
});

it('audits table creation and row effects once, without retaining row values in the ledger', async () => {
  const { createDataTablesStore } =
    await import('../../src/data-tables/index.js');
  const tables = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  try {
    const name = `Audit_${randomUUID().replaceAll('-', '')}`;
    const table = await tables.create({
      ...scope(),
      name,
      columns: [{ name: 'note', type: 'text', required: true }],
      idempotencyKey: randomUUID(),
    });
    const write = {
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'insert' as const,
        table: name,
        values: { note: 'PRIVATE_ROW_PAYLOAD' },
      },
    };
    const first = await tables.write(write);
    expect(await tables.write(write)).toEqual(first);
    const events = await store.list({
      ...scope(),
      query: { targetId: table.id, limit: 50 },
    });
    expect(events.items.map((event) => event.action).sort()).toEqual([
      'data.tables.create',
      'data.tables.rows.write',
    ]);
    expect(
      events.items.find((event) => event.action === 'data.tables.rows.write')
        ?.metadata,
    ).toMatchObject({ affected: 1, operation: 'insert' });
    const raw = await queryAsOwner<{ metadata: unknown }>(
      'select metadata from app.audit_events where workspace_id=$1 and target_id=$2',
      [workspaceId, table.id],
      workspaceId,
    );
    expect(JSON.stringify(raw)).not.toContain('PRIVATE_ROW_PAYLOAD');
  } finally {
    await tables.close();
  }
});

it('keeps microsecond audit filter boundaries and literal person search', async () => {
  const targetId = await insert();
  const list = (query: { from?: string; until?: string; person?: string }) =>
    store.list({ ...scope(), query: { ...query, targetId, limit: 10 } });
  const after = await list({ from: '2026-10-16T10:00:00.123457Z' });
  const before = await list({ until: '2026-10-16T10:00:00.123456Z' });
  expect(after.items).toEqual([]);
  expect(before.items).toEqual([]);
  expect(
    (
      await list({
        from: '2026-10-16T10:00:00.123456Z',
        until: '2026-10-16T10:00:00.123457Z',
      })
    ).items,
  ).toHaveLength(1);
  expect((await list({ person: '%' })).items).toEqual([]);
});
