import { randomUUID } from 'node:crypto';

import { IdempotencyConflictError } from '@pertexo/database/platform';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { WorkspaceVariablesConflictError } from '../../src/variables/contract.js';

import { admin } from '../../../database/test/lifecycle/calls/fixtures.js';
import { userId } from '../../../database/test/lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  member,
  scope,
  store,
} from './configuration/fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

async function storedRevisions(workspaceId: string) {
  return (
    await admin.query<{ revision: number }>(
      'select revision from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
      [workspaceId],
    )
  ).rows.map((row) => row.revision);
}

async function auditFacts(workspaceId: string) {
  return (
    await admin.query<{
      actor_user_id: string;
      target_type: string;
      target_id: string;
      request_id: string | null;
      trace_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      "select actor_user_id,target_type,target_id,request_id,trace_id,metadata from app.audit_events where workspace_id=$1 and action='workspace.variables_changed' order by occurred_at,id",
      [workspaceId],
    )
  ).rows;
}

// Digests of the canonical request text, as the code stored them before this
// area moved to core: changing what is hashed breaks retries in flight across a
// deploy. The key's digest is sha256('receipt-before-the-move').
it.each([
  [
    'no descriptions',
    {},
    '896465303d4d2cf09481296469562a70189e5447795a85c39f76f0dbbe0e4b3b',
  ],
  [
    'descriptions',
    { descriptions: { RATE: 'Daily rate' } },
    '8eed5b7f9f302bf1f53454f7d7ec22b9b7cf28af790c2bfd77f55a573851ce88',
  ],
])(
  'answers from a receipt written by the earlier code, with %s',
  async (_case, metadata, requestHash) => {
    const f = await fixture();
    await admin.query(
      `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
       values($1,$2,'workspace.variables.replace',$3,$4,$5,'completed',$2,'{"revision":7,"changed":true}'::jsonb)`,
      [
        randomUUID(),
        f.workspaceId,
        userId,
        'ac27497ffea97dbbade1aaff15598f17c336f5b89cdc49bfaa19d2e0a2bd211e',
        requestHash,
      ],
    );
    expect(
      await store.replace({
        ...scope(f.workspaceId),
        idempotencyKey: 'receipt-before-the-move',
        expectedRevision: 0,
        values: { RATE: 10 },
        ...metadata,
      }),
    ).toEqual({ revision: 7, changed: true, replayed: true });
    expect(await storedRevisions(f.workspaceId)).toEqual([]);
  },
);

it.each([
  ['omitted, then an empty map', undefined, {}],
  ['an empty map, then omitted', {}, undefined],
] as const)(
  'treats descriptions %s as different requests under one key',
  async (_case, first, second) => {
    const f = await fixture();
    const command = {
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      values: { RATE: 1 },
    };
    await store.replace({
      ...command,
      ...(first === undefined ? {} : { descriptions: first }),
    });
    await expect(
      store.replace({
        ...command,
        ...(second === undefined ? {} : { descriptions: second }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await storedRevisions(f.workspaceId)).toEqual([1]);
  },
);

it('keeps one actor from replaying the result of another actor using the same key', async () => {
  const f = await fixture();
  const adminId = await member(f.workspaceId, 'admin');
  const command = {
    workspaceId: f.workspaceId,
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  };
  await store.replace({ ...command, actorId: userId });
  await expect(
    store.replace({ ...command, actorId: adminId }),
  ).rejects.toBeInstanceOf(WorkspaceVariablesConflictError);
});

it('replays a no-op as the no-op it was, even after the set has moved on', async () => {
  const f = await fixture();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  });
  const noop = {
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { RATE: 1 },
  };
  expect(await store.replace(noop)).toEqual({
    revision: 1,
    changed: false,
    replayed: false,
  });
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    values: { RATE: 2 },
  });
  expect(await store.replace(noop)).toEqual({
    revision: 1,
    changed: false,
    replayed: true,
  });
});

it('applies one command once when its retries arrive together', async () => {
  const f = await fixture();
  const command = {
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  };
  const results = await Promise.all([
    store.replace(command),
    store.replace(command),
  ]);
  expect(results.map((result) => result.replayed).sort()).toEqual([
    false,
    true,
  ]);
  expect(await storedRevisions(f.workspaceId)).toEqual([1]);
  expect(await auditFacts(f.workspaceId)).toHaveLength(1);
});

it('refuses a stale save without storing anything, even one matching the current values', async () => {
  const f = await fixture();
  const save = (expectedRevision: number, value: number) =>
    store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision,
      values: { RATE: value },
    });
  await save(0, 1);
  await save(1, 2);
  await expect(save(1, 3)).rejects.toBeInstanceOf(
    WorkspaceVariablesConflictError,
  );
  await expect(save(9, 3)).rejects.toBeInstanceOf(
    WorkspaceVariablesConflictError,
  );
  await expect(save(1, 2)).rejects.toBeInstanceOf(
    WorkspaceVariablesConflictError,
  );
  expect(await storedRevisions(f.workspaceId)).toEqual([1, 2]);
  expect((await store.read(scope(f.workspaceId))).values).toEqual({ RATE: 2 });
  expect(await auditFacts(f.workspaceId)).toHaveLength(2);
});

it('records who changed the set and which request did it', async () => {
  const f = await fixture();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
    requestId: 'request-1',
    traceId: 'trace-1',
  });
  expect(await auditFacts(f.workspaceId)).toEqual([
    {
      actor_user_id: userId,
      target_type: 'workspace_variables',
      target_id: f.workspaceId,
      request_id: 'request-1',
      trace_id: 'trace-1',
      metadata: { revision: 1, changedNames: ['RATE'] },
    },
  ]);
});

it('lists exactly 100 changed names without calling them truncated', async () => {
  const f = await fixture();
  const values = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `NAME_${String(index).padStart(3, '0')}`,
      index,
    ]),
  );
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values,
  });
  const [fact] = await auditFacts(f.workspaceId);
  expect(fact?.metadata).toEqual({
    revision: 1,
    changedNames: Object.keys(values),
  });
});

it('refuses to edit from a head whose set is gone, rather than starting over from empty', async () => {
  const f = await fixture();
  await store.replace({
    ...scope(f.workspaceId),
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    values: { RATE: 1 },
  });
  // The foreign key forbids this state, so only a restore or a damaged database
  // reaches it: replica mode is the one way to build it here.
  await admin.query('set session_replication_role=replica');
  try {
    await admin.query(
      'update app.workspace_variables set revision=99 where workspace_id=$1',
      [f.workspaceId],
    );
  } finally {
    await admin.query('set session_replication_role=default');
  }
  await expect(
    store.replace({
      ...scope(f.workspaceId),
      idempotencyKey: randomUUID(),
      expectedRevision: 99,
      values: { RATE: 2 },
    }),
  ).rejects.toThrow('Workspace variable revision is missing');
  expect(await storedRevisions(f.workspaceId)).toEqual([1]);
  expect(await auditFacts(f.workspaceId)).toHaveLength(1);
});
