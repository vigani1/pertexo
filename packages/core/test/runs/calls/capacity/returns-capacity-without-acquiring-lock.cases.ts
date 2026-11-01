import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';

import {
  maintenanceUrl,
  randomUUID,
  waitForPostgresLock,
  withApplicationName,
} from '../../../lifecycle/retention.support.js';
import {
  admin,
  createFamily,
  insertHint,
} from '../../../lifecycle/calls/fixtures.js';
import { scoped, lend, setStatus, usage } from './fixture.js';

export function registerReturnsCapacityWithoutAcquiringLock(): void {
  it('returns capacity without acquiring a lock on the existing terminal child', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'succeeded');
    const hint = await insertHint(family.workspaceId, family.parentRunId);
    await admin.query('begin');
    try {
      await admin.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [family.childRunId],
      );
      expect(
        await scoped(family.workspaceId, async (client) => {
          await client.query("set local statement_timeout='2000ms'");
          return (
            await client.query<{ returned: boolean }>(
              'select app.return_workflow_run_slot($1,$2,$3) returned',
              [family.workspaceId, family.callId, hint],
            )
          ).rows[0]?.returned;
        }),
      ).toBe(true);
    } finally {
      await admin.query('rollback');
    }
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('waits for the parent writer while the child can settle independently', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    const hint = await insertHint(family.workspaceId, family.parentRunId);
    const name = `call-return-${randomUUID()}`;
    const competing = new Pool({
      connectionString: withApplicationName(maintenanceUrl, name),
      max: 1,
    });
    await admin.query('begin');
    let returning: Promise<boolean | undefined> | undefined;
    try {
      await admin.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [family.parentRunId],
      );
      returning = withTenantScopedClient(
        competing,
        { workspaceId: family.workspaceId },
        async (client) =>
          (
            await client.query<{ returned: boolean }>(
              'select app.return_workflow_run_slot($1,$2,$3) returned',
              [family.workspaceId, family.callId, hint],
            )
          ).rows[0]?.returned,
      );
      await waitForPostgresLock(name);
      await setStatus(family.workspaceId, family.childRunId, 'succeeded');
      await admin.query('commit');
      expect(await returning).toBe(true);
    } finally {
      await admin.query('rollback');
      await returning;
      await competing.end();
    }
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
  });
}
