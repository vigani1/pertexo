import { describe, expect, it } from 'vitest';

import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/readiness.js';
import {
  acceptFixture,
  apiPool,
  expectPgCode,
  withOwnerRole,
  workerPool,
  workspaceId,
} from './support/preview-worker-fixture.js';

describe('preview worker schema contract', () => {
  it('reports the preview artifact ownership migration and least-privilege grants ready', async () => {
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
    await expect(
      checkDatabaseReadiness(workerPool, {
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ migrationHead: EXPECTED_MIGRATION_HEAD });
  });

  it('rejects a same-named usage foreign key with incompatible semantics', async () => {
    await withOwnerRole(async (client) => {
      await client.query(
        'alter table app.usage_events drop constraint usage_events_workspace_fk',
      );
      await client.query(
        `alter table app.usage_events
           add constraint usage_events_workspace_fk
           foreign key (workspace_id) references app.workspaces (id)`,
      );
    });
    try {
      await expect(
        checkDatabaseReadiness(apiPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow(
        'Preview terminal fact schema or grants are incompatible',
      );
    } finally {
      await withOwnerRole(async (client) => {
        await client.query(
          'alter table app.usage_events drop constraint usage_events_workspace_fk',
        );
        await client.query(
          `alter table app.usage_events
             add constraint usage_events_workspace_fk
             foreign key (workspace_id) references app.workspaces (id)
             on delete restrict`,
        );
      });
    }
  });

  it('rejects mutation of terminal correlation and classification pins', async () => {
    const accepted = await acceptFixture();
    await expect(
      withOwnerRole(async (client) => {
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await client.query(
          `update app.preview_runs
              set request_id='forged-request',provider_key='forged'
            where workspace_id=$1 and id=$2`,
          [workspaceId, accepted.previewRunId],
        );
      }),
    ).rejects.toSatisfy(expectPgCode('55000'));
  });

  it('rejects a no-op replacement for the immutable-pin trigger function', async () => {
    const originalDefinition = await withOwnerRole(async (client) => {
      const definition = await client.query<{ definition: string }>(
        `select pg_get_functiondef(
           to_regprocedure('app.reject_preview_run_pin_change()')
         ) as definition`,
      );
      await client.query(`
        create or replace function app.reject_preview_run_pin_change()
        returns trigger
        language plpgsql
        set search_path = pg_catalog, pg_temp
        as $function$
        begin
          return new;
        end;
        $function$
      `);
      const stored = definition.rows[0]?.definition;
      if (stored === undefined)
        throw new Error('immutable preview pin function is missing');
      return stored;
    });
    try {
      await expect(
        checkDatabaseReadiness(apiPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow(
        'Preview terminal fact schema or grants are incompatible',
      );
    } finally {
      await withOwnerRole((client) => client.query(originalDefinition));
    }
  });
});
