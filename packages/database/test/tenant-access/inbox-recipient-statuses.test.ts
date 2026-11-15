import { readFile } from 'node:fs/promises';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { expect, it } from 'vitest';

// schema.sql is the migrated catalog, held to the live database by database-catalog.mjs.
const schema = readFile(new URL('../../schema.sql', import.meta.url), 'utf8');

it("lets row security show inbox items in exactly policy's browsable workspace statuses", async () => {
  const source = await schema;
  const start = source.indexOf(
    'CREATE FUNCTION app.workspace_inbox_recipient_eligible(',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('$$;', start));
  const written = /w\.status IN \(([^)]*)\)/u.exec(body)?.[1];
  expect(written).toBeDefined();
  const statuses = [...(written ?? '').matchAll(/'([a-z_]+)'/gu)].map(
    ([, status]) => status,
  );
  expect(statuses.toSorted()).toEqual(
    [...BROWSABLE_WORKSPACE_STATUSES].toSorted(),
  );
});
