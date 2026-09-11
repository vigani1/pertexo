import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const createDatabasePool = vi.hoisted(() => vi.fn());

vi.mock('../src/platform/postgres-telemetry.js', () => ({
  createDatabasePool,
}));

import { createOperatorCommandRuntime } from '../src/operator/operator-command-runtime.js';

const readyRow = Object.freeze({
  postgres_major: 18,
  migration_head: EXPECTED_MIGRATION_HEAD,
  rolsuper: false,
  rolbypassrls: false,
  owner_member: false,
  forbidden_member: false,
  expected_role: true,
  direct_outbox: false,
  direct_audit: false,
  direct_command: false,
  direct_evidence: false,
  direct_execution: false,
  private_command: false,
  can_command: true,
  can_execution_commands: true,
  can_trigger_command: true,
  can_replay_command: true,
  can_maintenance_rerun: true,
  can_get: true,
});

const config = parseDatabaseConfig({
  connectionString: 'postgresql://operator.invalid/pertexo',
});

function runtimeFor(row: Readonly<Record<string, unknown>>) {
  const query = vi.fn((request: string | { text: string }) =>
    Promise.resolve({
      rows:
        typeof request !== 'string' &&
        request.text.includes("current_setting('server_version_num')")
          ? [row]
          : [],
    }),
  );
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(() => Promise.resolve(client)),
    end: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
  };
  createDatabasePool.mockReturnValue(pool);
  return {
    client,
    pool,
    runtime: createOperatorCommandRuntime(config, 'pertexo_operator', {}),
  };
}

describe('operator command runtime readiness', () => {
  beforeEach(() => {
    createDatabasePool.mockReset();
  });

  it('accepts one complete snapshot and preserves the transaction order', async () => {
    const { client, runtime } = runtimeFor(readyRow);

    await expect(runtime.checkReadiness()).resolves.toBeUndefined();

    expect(
      client.query.mock.calls.map(([request]) =>
        typeof request === 'string' ? request : request.text,
      ),
    ).toEqual([
      'begin',
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      expect.stringContaining("current_setting('server_version_num')"),
      'commit',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong role', { expected_role: false }],
    ['forbidden membership', { forbidden_member: true }],
    ['direct grant', { direct_outbox: true }],
    ['missing capability', { can_execution_commands: false }],
    ['unsupported release', { migration_head: '0080_older.sql' }],
  ])('rejects %s fail closed', async (_scenario, override) => {
    const { runtime } = runtimeFor({ ...readyRow, ...override });

    await expect(runtime.checkReadiness()).rejects.toThrow(
      'Operator command database boundary is incompatible',
    );
  });
});
