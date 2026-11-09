import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('preserves existing receipts while admitting bounded sharing responses at the supported population', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const receiptId = randomUUID();
    await admin.query(
      `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
       values($1,$2,'folder.sharing','folder',$3,$4,'completed',$5,'{"revision":1}')`,
      [receiptId, workspaceId, 'a'.repeat(64), 'b'.repeat(64), workflowId],
    );

    expect(
      (
        await admin.query(
          'select result_ref from app.idempotency_records where id=$1',
          [receiptId],
        )
      ).rows,
    ).toEqual([{ result_ref: { revision: 1 } }]);
    const labels = Object.fromEntries(
      Array.from({ length: 100 }, () => [randomUUID(), '界'.repeat(256)]),
    );
    await admin.query(
      'update app.idempotency_records set result_ref=$2 where id=$1',
      [receiptId, JSON.stringify({ labels })],
    );
    expect(
      (
        await admin.query(
          'select result_ref from app.idempotency_records where id=$1',
          [receiptId],
        )
      ).rows,
    ).toEqual([{ result_ref: { labels } }]);
    await expect(
      admin.query(
        'update app.idempotency_records set result_ref=$2 where id=$1',
        [receiptId, JSON.stringify({ value: 'x'.repeat(196608) })],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'idempotency_records_result_ref_bounded',
    });
  });
});

it('upgrades retained receipts to fit the supported labels even when every character needs JSON escaping', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const receiptId = randomUUID();
    await admin.query(
      `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref)
       values($1,$2,'folder.sharing','folder',$3,$4,'completed',$5,'{"revision":1}')`,
      [receiptId, workspaceId, 'a'.repeat(64), 'b'.repeat(64), workflowId],
    );
    const result = {
      revision: 1,
      labels: Object.fromEntries(
        Array.from({ length: 100 }, () => [randomUUID(), '\u0001'.repeat(256)]),
      ),
    };
    const update = (value: unknown) =>
      admin.query(
        'update app.idempotency_records set result_ref=$2 where id=$1',
        [receiptId, JSON.stringify(value)],
      );

    expect(
      (
        await admin.query(
          'select result_ref from app.idempotency_records where id=$1',
          [receiptId],
        )
      ).rows,
    ).toEqual([{ result_ref: { revision: 1 } }]);
    await update(result);
    expect(
      (
        await admin.query(
          'select result_ref from app.idempotency_records where id=$1',
          [receiptId],
        )
      ).rows,
    ).toEqual([{ result_ref: result }]);
    await expect(update({ value: 'x'.repeat(196608) })).rejects.toMatchObject({
      code: '23514',
      constraint: 'idempotency_records_result_ref_bounded',
    });
  });
});
