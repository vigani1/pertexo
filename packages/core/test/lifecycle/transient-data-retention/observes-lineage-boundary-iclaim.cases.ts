import { createRetentionDatabase } from '../../../src/lifecycle/retention/store.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import { expect, it } from 'vitest';
import { maintenanceUrl } from '../retention.support.js';
import { asOwner, insertReplacement } from './fixture.js';

export function registerObservesLineageBoundaryIClaim(): void {
  it.each([32, 33])(
    'observes the lineage boundary for a %i-claim chain',
    async (length) => {
      const ids = Array.from(
        { length: length + 1 },
        (_, index) =>
          `00000000-0000-4000-8000-${(4096 + index).toString(16).padStart(12, '0')}`,
      );
      const one = createRetentionDatabase(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
        { pageSize: 1 },
      );
      try {
        for (let index = 0; index < length; index++) {
          const id = ids[index];
          const next = ids[index + 1];
          if (id === undefined || next === undefined)
            throw new Error('Missing lineage fixture');
          await insertReplacement(id, next);
        }
        const pass = await one.enforce();
        expect(pass.removed.invitation_replacement_claims).toBe(1);
        const roots = await asOwner<{ count: number }>(
          'select count(*)::integer count from app.workspace_invitation_binding_replacement_claims where prior_intent_id=$1',
          [ids[0]],
        );
        expect(roots.rows).toEqual([{ count: length === 32 ? 0 : 1 }]);
      } finally {
        await one.close();
        await asOwner(
          'delete from app.workspace_invitation_binding_replacement_claims where prior_intent_id=any($1::uuid[])',
          [ids],
        );
      }
    },
  );
}
