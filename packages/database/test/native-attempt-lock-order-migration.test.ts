import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0141_native_attempt_lock_order.sql',
  import.meta.url,
);

it('repairs only the existing native attempt lock owner without changing its ABI or authority', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  expect(
    sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+app\.([a-z_]+)/giu),
  ).toEqual(['CREATE OR REPLACE FUNCTION app.lock_native_attempt_value_owner']);
  expect(sql).toMatch(
    /lock_native_attempt_value_owner\(p_authority jsonb\)\s+RETURNS jsonb LANGUAGE plpgsql/iu,
  );
  expect(sql).toContain(
    'SET search_path=pg_catalog,app,pg_temp SET row_security=on',
  );
  expect(sql).not.toMatch(
    /SECURITY\s+DEFINER|\bGRANT\b|\bREVOKE\b|\bDROP\b|CREATE\s+(?:TABLE|INDEX|TRIGGER)/iu,
  );
  expect(
    sql.match(/app\.native_attempt_value_owner\(p_authority\)/gu),
  ).toHaveLength(2);
  expect(sql).toContain('app.lock_workspace_run_admission(v_workspace)');
  expect(sql).toContain('app.native_call_lineage');
  expect(sql).toContain("receipt.consumer_name='node-attempt-worker'");
  expect(sql).toContain("p_authority#>>'{delivery,outboxEventId}'");
  const ancestorLock = sql.indexOf('FOR SHARE');
  const receiptLock = sql.indexOf('FROM app.inbox_receipts');
  const currentRunLock = sql.indexOf('FROM app.workflow_runs', receiptLock);
  const nodeLock = sql.indexOf('FROM app.node_runs');
  const attemptLock = sql.indexOf('FROM app.node_attempts');
  expect(ancestorLock).toBeGreaterThan(0);
  expect(receiptLock).toBeGreaterThan(ancestorLock);
  expect(currentRunLock).toBeGreaterThan(receiptLock);
  expect(nodeLock).toBeGreaterThan(currentRunLock);
  expect(attemptLock).toBeGreaterThan(nodeLock);
  expect(sql.slice(currentRunLock, nodeLock)).toContain('FOR UPDATE');
  // The current run must never be SHARE-locked then upgraded by sibling writers.
  expect(sql.slice(0, ancestorLock)).toContain(
    'FOR v_index IN REVERSE cardinality(v_path)..2 LOOP',
  );
  expect(sql).toContain('RETURN app.native_attempt_value_owner(p_authority)');
});

it('preserves frozen 0139 and 0141 sources while unreleased main 0140 is repaired', async () => {
  for (const [name, hash] of [
    [
      '0139_workflow_json_calls.sql',
      '564f752edb632f18c57d7e47cce61948cea1a6c3fed7c842ad3475ddc580596b',
    ],
    [
      '0141_native_attempt_lock_order.sql',
      'f5fb224cc5bda7e69dacfe05d4a47be9dd37b6a99bc5368e29dd8ef8cf37ca90',
    ],
  ] as const) {
    const bytes = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  }
});
