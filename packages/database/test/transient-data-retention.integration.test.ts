import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  owner,
  randomUUID,
  retention,
  userId,
  workspaceId,
} from './support/retention.integration.support.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function asOwner(text: string, values: readonly unknown[] = []) {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query(text, [...values]);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

describe('transient data retention', () => {
  it('reaps only bounded terminal replay records and permits defined key reuse', async () => {
    const keyHashes = [
      'expired-1',
      'expired-2',
      'expired-3',
      'in-progress',
    ].map(digest);
    for (const [index, keyHash] of keyHashes.entries()) {
      await asOwner(
        `insert into app.idempotency_records
          (id,workspace_id,operation,scope,key_hash,request_hash,status,
           resource_id,result_ref,created_at,expires_at)
         values($1,$2,'connection.update','connection:test',$3,$4,$5,$6,
           '{}'::jsonb,clock_timestamp()-interval '2 days',
           clock_timestamp()-interval '1 day')`,
        [
          randomUUID(),
          workspaceId,
          keyHash,
          digest(`request-${index}`),
          index === 3 ? 'in_progress' : 'completed',
          randomUUID(),
        ],
      );
    }

    const first = await retention.reapTransientData();
    expect(first.idempotencyRecordsDeleted).toBe(2);
    const second = await retention.reapTransientData();
    expect(second.idempotencyRecordsDeleted).toBe(1);

    const remaining = await asOwner(
      `select status,count(*)::integer count
       from app.idempotency_records
       where workspace_id=$1 and operation='connection.update'
       group by status`,
      [workspaceId],
    );
    expect(remaining.rows).toEqual([{ status: 'in_progress', count: 1 }]);

    await expect(
      asOwner(
        `insert into app.idempotency_records
          (id,workspace_id,operation,scope,key_hash,request_hash,status,
           resource_id,result_ref)
         values($1,$2,'connection.update','connection:test',$3,$4,
           'completed',$5,'{}'::jsonb)`,
        [
          randomUUID(),
          workspaceId,
          keyHashes[0],
          digest('replacement-request'),
          randomUUID(),
        ],
      ),
    ).resolves.toBeDefined();
  });

  it('preserves active sessions and lock-safe concurrent logout metadata', async () => {
    const activeId = randomUUID();
    const expiredId = randomUUID();
    const concurrentLogoutId = randomUUID();
    await asOwner(
      `insert into app.sessions
        (id,user_id,token_digest,created_at,expires_at)
       values
        ($1,$4,$5,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day'),
        ($2,$4,$6,clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days'),
        ($3,$4,$7,clock_timestamp()-interval '40 days',clock_timestamp()-interval '31 days')`,
      [
        activeId,
        expiredId,
        concurrentLogoutId,
        userId,
        digest(activeId),
        digest(expiredId),
        digest(concurrentLogoutId),
      ],
    );

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `update app.sessions set revoked_at=clock_timestamp()
         where id=$1`,
        [concurrentLogoutId],
      );
      const duringLogout = await retention.reapTransientData();
      expect(duringLogout.sessionsDeleted).toBe(1);
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const retained = await asOwner(
      `select id,revoked_at is not null revoked
       from app.sessions where id=any($1::uuid[]) order by id`,
      [[activeId, concurrentLogoutId]],
    );
    expect(retained.rows).toHaveLength(2);
    expect(retained.rows.find((row) => row.id === concurrentLogoutId)).toEqual(
      expect.objectContaining({ revoked: true }),
    );
  });
});
