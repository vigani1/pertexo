import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
  IdempotencyConflictError,
} from '../../src/platform/idempotency/repository.js';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import { seedWorkflow, withDatabase } from './migrations/upgrade-fixture.js';

it.each(['claim', 'read'] as const)(
  'refuses an unreadable completed receipt on %s instead of reporting a new key',
  async (reader) => {
    await withDatabase(async ({ admin, config }) => {
      const { workspaceId } = await seedWorkflow(admin);
      const url = new URL(process.env.DATABASE_URL ?? '');
      url.pathname = new URL(config.connectionString).pathname;
      const pool = new Pool({ connectionString: url.href, max: 1 });
      const identity = {
        workspaceId,
        operation: 'receipt.proof',
        scope: workspaceId,
        idempotencyKey: randomUUID(),
      };
      const command = {
        ...identity,
        resourceId: workspaceId,
        request: { save: true },
      };
      try {
        await withTenantScopedClient(pool, { workspaceId }, async (client) => {
          expect(await claimCommand(client, command)).toBeNull();
          await completeCommand(client, identity, { saved: true });
        });
        await admin.query(
          "update app.idempotency_records set result_ref='null'::jsonb where workspace_id=$1",
          [workspaceId],
        );
        await expect(
          withTenantScopedClient(pool, { workspaceId }, (client) =>
            reader === 'claim'
              ? claimCommand(client, command)
              : findCommandResult(client, command),
          ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        expect(
          (
            await admin.query(
              'select status,result_ref from app.idempotency_records where workspace_id=$1',
              [workspaceId],
            )
          ).rows,
        ).toEqual([{ status: 'completed', result_ref: null }]);
      } finally {
        await pool.end();
      }
    });
  },
);

it('keeps readable false results and void-result envelopes replayable', async () => {
  await withDatabase(async ({ admin, config }) => {
    const { workspaceId } = await seedWorkflow(admin);
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.pathname = new URL(config.connectionString).pathname;
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      for (const value of [false, { result: null }]) {
        const identity = {
          workspaceId,
          operation: 'receipt.control',
          scope: workspaceId,
          idempotencyKey: randomUUID(),
        };
        const command = {
          ...identity,
          resourceId: workspaceId,
          request: { save: true },
        };
        await withTenantScopedClient(pool, { workspaceId }, async (client) => {
          expect(await claimCommand(client, command)).toBeNull();
          await completeCommand(client, identity, value);
        });
        await withTenantScopedClient(pool, { workspaceId }, async (client) => {
          expect(await claimCommand(client, command)).toEqual(value);
          expect(await findCommandResult(client, command)).toEqual(value);
        });
      }
    } finally {
      await pool.end();
    }
  });
});
