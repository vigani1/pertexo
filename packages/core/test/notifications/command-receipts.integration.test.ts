import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { command, createConnection, destinations } from './rotation.support.js';
import {
  asAdmin,
  workflowA,
  workspaceA,
} from '../runs/run-store/run-store.fixture.js';

it.each(['create', 'append', 'status', 'set policy', 'clear policy'] as const)(
  'refuses unreadable %s output without replaying success or changing rows',
  async (operation) => {
    const { connectionId } = await createConnection('slack');
    const destinationId = randomUUID();
    const create = {
      ...command(),
      destinationId,
      config: { kind: 'slack' as const, connectionId, channelId: 'CRECEIPT' },
    };
    await destinations.create(create);
    let key = create.idempotencyKey;
    let receiptOperation = 'failure.notification.destination.create';
    let replay: () => Promise<unknown> = () => destinations.create(create);
    let damaged = '{ "result": {} }';
    if (operation === 'append') {
      const input = {
        ...command(),
        destinationId,
        expectedVersion: 1,
        config: {
          kind: 'slack' as const,
          connectionId,
          channelId: 'CREPLACED',
        },
      };
      await destinations.appendVersion(input);
      key = input.idempotencyKey;
      receiptOperation = 'failure.notification.destination.version.append';
      replay = () => destinations.appendVersion(input);
    }
    if (operation === 'status') {
      const input = {
        ...command(),
        destinationId,
        status: 'disabled' as const,
      };
      await destinations.setStatus(input);
      key = input.idempotencyKey;
      receiptOperation = 'failure.notification.destination.status';
      replay = () => destinations.setStatus(input);
    }
    if (operation === 'set policy' || operation === 'clear policy') {
      const input = { ...command(), workflowId: workflowA, destinationId };
      await destinations.setWorkflowPolicy(input);
      key = input.idempotencyKey;
      receiptOperation = 'workflow.failure.notification.policy.set';
      replay = () => destinations.setWorkflowPolicy(input);
      damaged = '{ "result": { "unexpected": true } }';
      if (operation === 'clear policy') {
        const clear = { ...command(), workflowId: workflowA };
        await destinations.clearWorkflowPolicy(clear);
        key = clear.idempotencyKey;
        receiptOperation = 'workflow.failure.notification.policy.clear';
        replay = () => destinations.clearWorkflowPolicy(clear);
      }
    }
    const stored = () =>
      asAdmin(async (pool) => ({
        destination: (
          await pool.query(
            'select to_jsonb(d) value from app.failure_notification_destinations d where id=$1',
            [destinationId],
          )
        ).rows,
        versions: (
          await pool.query(
            'select to_jsonb(v) value from app.failure_notification_destination_versions v where destination_id=$1 order by version',
            [destinationId],
          )
        ).rows,
        policy: (
          await pool.query(
            'select to_jsonb(p) value from app.workflow_failure_notification_policies p where workspace_id=$1 and workflow_id=$2',
            [workspaceA, workflowA],
          )
        ).rows,
      }));
    const before = await stored();
    const keyHash = createHash('sha256').update(key).digest('hex');
    const changed = await asAdmin((pool) =>
      pool.query(
        'update app.idempotency_records set result_ref=$4::jsonb where workspace_id=$1 and operation=$2 and key_hash=$3',
        [workspaceA, receiptOperation, keyHash, damaged],
      ),
    );
    expect(changed.rowCount).toBe(1);
    await expect(replay()).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await stored()).toEqual(before);
  },
);
