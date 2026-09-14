import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { parseDatabaseConfig } from '../src/config.js';
import { EXPECTED_MIGRATION_HEAD } from '../src/platform/readiness.js';

const createDatabasePool = vi.hoisted(() => vi.fn());

vi.mock('../src/platform/postgres-telemetry.js', () => ({
  createDatabasePool,
}));

import { createOperatorCommandRuntime } from '../src/operator/operator-command-runtime.js';
import { OperatorCommandConflictError } from '../src/operator/operator-command-errors.js';

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

function runtimeWith(
  query: ReturnType<typeof vi.fn>,
  connect: ReturnType<typeof vi.fn> = vi.fn(),
  end: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
) {
  const release = vi.fn();
  const destroy = vi.fn();
  const client = {
    connection: { stream: { destroy } },
    query,
    release,
  };
  if (connect.getMockImplementation() === undefined)
    connect.mockResolvedValue(client);
  const pool = { connect, end, on: vi.fn() };
  createDatabasePool.mockReturnValue(pool);
  return {
    client,
    destroy,
    pool,
    release,
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

describe('operator command transaction ownership', () => {
  beforeEach(() => {
    createDatabasePool.mockReset();
  });

  it('rejects a pre-aborted operation without checking out a client', async () => {
    const fixture = runtimeWith(vi.fn().mockResolvedValue({ rows: [] }));
    const controller = new AbortController();
    const reason = new Error('operator canceled before checkout');
    controller.abort(reason);

    await expect(
      fixture.runtime.transaction('select 1', [], controller.signal),
    ).rejects.toBe(reason);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it('releases a client that arrives after checkout cancellation', async () => {
    const pending = Promise.withResolvers<PoolClient>();
    const connect = vi.fn(() => pending.promise);
    const fixture = runtimeWith(
      vi.fn().mockResolvedValue({ rows: [] }),
      connect,
    );
    const controller = new AbortController();
    const reason = new Error('operator canceled during checkout');
    const operation = fixture.runtime.transaction(
      'select 1',
      [],
      controller.signal,
    );
    const rejection = expect(operation).rejects.toBe(reason);

    controller.abort(reason);
    await rejection;
    pending.resolve(fixture.client as unknown as PoolClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.client.query).not.toHaveBeenCalled();
  });

  it('destroys an in-flight command client and preserves the abort reason', async () => {
    const held = Promise.withResolvers<{ rows: never[] }>();
    const started = Promise.withResolvers<undefined>();
    const query = vi.fn((request: { text: string }) => {
      if (request.text === 'select held') {
        started.resolve(undefined);
        return held.promise;
      }
      return Promise.resolve({ rows: [] });
    });
    const fixture = runtimeWith(query);
    const controller = new AbortController();
    const reason = new Error('operator canceled during command');
    const operation = fixture.runtime.transaction(
      'select held',
      [],
      controller.signal,
    );
    const rejection = expect(operation).rejects.toBe(reason);

    await started.promise;
    controller.abort(reason);
    held.reject(new Error('socket terminated'));
    await rejection;

    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release.mock.calls[0]?.[0]).toBe(reason);
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.some(([request]) => request.text === 'rollback'),
    ).toBe(false);
  });

  it.each(['begin', 'commit'] as const)(
    'destroys a client canceled during %s without attempting rollback',
    async (phase) => {
      const held = Promise.withResolvers<{ rows: never[] }>();
      const started = Promise.withResolvers<undefined>();
      const query = vi.fn((request: { text: string }) => {
        if (request.text === phase) {
          started.resolve(undefined);
          return held.promise;
        }
        return Promise.resolve({ rows: [] });
      });
      const fixture = runtimeWith(query);
      const controller = new AbortController();
      const reason = new Error(`operator canceled during ${phase}`);
      const operation = fixture.runtime.transaction(
        'select phase',
        [],
        controller.signal,
      );
      const rejection = expect(operation).rejects.toBe(reason);

      await started.promise;
      controller.abort(reason);
      held.reject(new Error(`${phase} socket terminated`));
      await rejection;

      expect(fixture.destroy).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledWith(reason);
      expect(
        query.mock.calls.some(([request]) => request.text === 'rollback'),
      ).toBe(false);
    },
  );

  it('aggregates rollback failure and poisons the client', async () => {
    const primary = new Error('command failed');
    const rollback = new Error('rollback failed');
    const query = vi.fn((request: string | { text: string }) => {
      const text = typeof request === 'string' ? request : request.text;
      if (text === 'select broken') return Promise.reject(primary);
      if (text === 'rollback') return Promise.reject(rollback);
      return Promise.resolve({ rows: [] });
    });
    const fixture = runtimeWith(query);

    const failure = await fixture.runtime
      .transaction('select broken', [])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, rollback]);
    expect(fixture.release).toHaveBeenCalledWith(true);
  });

  it('treats a rejected COMMIT acknowledgement as uncertain and poisons the client', async () => {
    const commit = new Error('commit acknowledgement lost');
    const query = vi.fn((request: { text: string }) =>
      request.text === 'commit'
        ? Promise.reject(commit)
        : Promise.resolve({ rows: [] }),
    );
    const fixture = runtimeWith(query);

    await expect(fixture.runtime.transaction('select 1', [])).rejects.toBe(
      commit,
    );
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(
      query.mock.calls.some(([request]) => request.text === 'rollback'),
    ).toBe(false);
  });

  it('rolls back a malformed command row before it can commit', async () => {
    const query = vi.fn((request: string | { text: string }) => {
      const text = typeof request === 'string' ? request : request.text;
      return Promise.resolve({
        rows: text === 'select malformed' ? [{ command_id: randomUUID() }] : [],
      });
    });
    const fixture = runtimeWith(query);

    await expect(
      fixture.runtime.execute('select malformed', []),
    ).rejects.toThrow();
    expect(
      query.mock.calls.map(([request]) =>
        typeof request === 'string' ? request : request.text,
      ),
    ).toEqual([
      'begin',
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      'select malformed',
      'rollback',
    ]);
    expect(fixture.release).toHaveBeenCalledWith(undefined);
  });

  it('commits a validated conflict row before translating its public error', async () => {
    const query = vi.fn((request: string | { text: string }) => {
      const text = typeof request === 'string' ? request : request.text;
      return Promise.resolve({
        rows:
          text === 'select conflict'
            ? [
                {
                  command_id: randomUUID(),
                  command_outcome: 'conflict',
                  command_status: 'failed',
                  replayed: false,
                  result: {},
                },
              ]
            : [],
      });
    });
    const fixture = runtimeWith(query);

    await expect(
      fixture.runtime.execute('select conflict', []),
    ).rejects.toBeInstanceOf(OperatorCommandConflictError);
    expect(
      query.mock.calls.map(([request]) =>
        typeof request === 'string' ? request : request.text,
      ),
    ).toEqual([
      'begin',
      "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      'select conflict',
      'commit',
    ]);
  });

  it('memoizes concurrent, sequential, and failed close settlement', async () => {
    const closeFailure = new Error('pool close failed');
    const end = vi.fn().mockRejectedValue(closeFailure);
    const fixture = runtimeWith(
      vi.fn().mockResolvedValue({ rows: [] }),
      vi.fn(),
      end,
    );

    const first = fixture.runtime.close();
    const concurrent = fixture.runtime.close();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toBe(closeFailure);
    await expect(fixture.runtime.close()).rejects.toBe(closeFailure);
    expect(end).toHaveBeenCalledOnce();
  });

  it('shares one close promise while the pool drains in-flight work', async () => {
    const drain = Promise.withResolvers<undefined>();
    const end = vi.fn(() => drain.promise);
    const fixture = runtimeWith(
      vi.fn().mockResolvedValue({ rows: [] }),
      vi.fn(),
      end,
    );

    const first = fixture.runtime.close();
    expect(fixture.runtime.close()).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(end).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    drain.resolve(undefined);
    await expect(first).resolves.toBeUndefined();
    expect(fixture.runtime.close()).toBe(first);
    expect(end).toHaveBeenCalledOnce();
  });
});
