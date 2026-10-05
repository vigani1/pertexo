import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { READINESS_WORKFLOW_CALL_SQL } from '../src/platform/readiness-workflow-call.sql.js';

it('pins every function created or replaced by the registered inline migration', async () => {
  const migration = await readFile(
    new URL('../migrations/0139_workflow_json_calls.sql', import.meta.url),
    'utf8',
  );
  const declared = [
    ...migration.matchAll(
      /^CREATE(?: OR REPLACE)? FUNCTION app\.([a-z_][a-z0-9_]*)/gmu,
    ),
  ]
    .map((match) => match[1])
    .sort();
  const pinned = [
    ...new Set(
      [
        ...READINESS_WORKFLOW_CALL_SQL.matchAll(/'app\.([a-z_][a-z0-9_]*)\(/gu),
      ].map((match) => match[1]),
    ),
  ].sort();
  expect(declared).toHaveLength(58);
  expect(pinned).toEqual(declared);
});
