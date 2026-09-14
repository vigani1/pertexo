import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../src/platform/postgres-telemetry.js', () => ({
  createDatabasePool: () => ({
    connect: database.connect,
    end: database.end,
  }),
}));

import { createCompatibilityReleaseMaintenance } from '../src/compatibility/compatibility-release-maintenance.js';

const config = {
  connectionString: 'postgresql://maintenance:secret@db/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 1,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const expectation = {
  epoch: 1,
  fingerprint:
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
  catalogJson:
    '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
} as const;

const prepareInput = {
  actorId: 'deployment-controller',
  actorKind: 'deployment',
  expectedPredecessor: expectation,
  reason: 'Prepare a compatible release',
  target: { ...expectation, epoch: 2 },
} as const;

function sqlText(value: unknown): string {
  return String(value).replaceAll(/\s+/gu, ' ').trim();
}

describe('compatibility release maintenance transaction ownership', () => {
  beforeEach(() => {
    database.connect.mockReset();
    database.end.mockClear();
    database.query.mockReset();
    database.release.mockReset();
    database.connect.mockResolvedValue({
      query: database.query,
      release: database.release,
    });
    database.query.mockImplementation((statement: unknown) =>
      Promise.resolve(
        sqlText(statement) === 'select current_user'
          ? { rows: [{ current_user: config.ownerRole }] }
          : { rows: [] },
      ),
    );
  });

  it('validates inputs before acquiring a client', async () => {
    const maintenance = createCompatibilityReleaseMaintenance(config);

    await expect(
      maintenance.prepare({ ...prepareInput, reason: '' }),
    ).rejects.toThrow();
    expect(database.connect).not.toHaveBeenCalled();
    await maintenance.close();
  });

  it('releases a successfully committed client as reusable', async () => {
    const maintenance = createCompatibilityReleaseMaintenance(config);

    await expect(maintenance.prepare(prepareInput)).resolves.toBeUndefined();
    expect(database.query.mock.calls.map(([sql]) => sqlText(sql))).toEqual([
      'begin',
      'set local role "pertexo_owner"',
      'select current_user',
      expect.stringContaining('app.prepare_node_compatibility_release'),
      'commit',
    ]);
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith(undefined);
    await maintenance.close();
  });

  it('preserves acquisition failure without attempting client cleanup', async () => {
    const failure = new Error('connect failed');
    database.connect.mockRejectedValueOnce(failure);
    const maintenance = createCompatibilityReleaseMaintenance(config);

    await expect(maintenance.prepare(prepareInput)).rejects.toBe(failure);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.release).not.toHaveBeenCalled();
    await maintenance.close();
  });

  it.each([
    ['begin', 0],
    ['set role', 1],
    ['role read-back', 2],
    ['operation', 3],
    ['commit', 4],
  ] as const)(
    'rolls back and preserves a %s failure',
    async (_phase, index) => {
      const failure = new Error(`phase ${String(index)} failed`);
      database.query.mockImplementation((statement: unknown) => {
        if (database.query.mock.calls.length === index + 1)
          return Promise.reject(failure);
        return Promise.resolve(
          sqlText(statement) === 'select current_user'
            ? { rows: [{ current_user: config.ownerRole }] }
            : { rows: [] },
        );
      });
      const maintenance = createCompatibilityReleaseMaintenance(config);

      await expect(maintenance.prepare(prepareInput)).rejects.toBe(failure);
      expect(sqlText(database.query.mock.lastCall?.[0])).toBe('rollback');
      expect(database.release).toHaveBeenCalledWith(undefined);
      await maintenance.close();
    },
  );

  it('discards after rollback failure while preserving the operation error', async () => {
    const operationFailure = new Error('prepare failed');
    const rollbackFailure = new Error('rollback failed');
    database.query.mockImplementation((statement: unknown) => {
      const sql = sqlText(statement);
      if (sql.includes('app.prepare_node_compatibility_release'))
        return Promise.reject(operationFailure);
      if (sql === 'rollback') return Promise.reject(rollbackFailure);
      return Promise.resolve(
        sql === 'select current_user'
          ? { rows: [{ current_user: config.ownerRole }] }
          : { rows: [] },
      );
    });
    const maintenance = createCompatibilityReleaseMaintenance(config);

    await expect(maintenance.prepare(prepareInput)).rejects.toBe(
      operationFailure,
    );
    expect(database.release).toHaveBeenCalledOnce();
    const disposal = database.release.mock.calls[0]?.[0] as unknown;
    expect(disposal).toBeInstanceOf(Error);
    expect(disposal).toMatchObject({ cause: rollbackFailure });
    await maintenance.close();
  });

  it('preserves the operation error when disposal reporting throws', async () => {
    const operationFailure = new Error('prepare failed');
    const releaseFailure = new Error('release failed');
    database.query.mockRejectedValueOnce(operationFailure);
    database.query.mockRejectedValueOnce(new Error('rollback failed'));
    database.release.mockImplementationOnce(() => {
      throw releaseFailure;
    });
    const maintenance = createCompatibilityReleaseMaintenance(config);

    await expect(maintenance.prepare(prepareInput)).rejects.toBe(
      operationFailure,
    );
    expect(database.release).toHaveBeenCalledOnce();
    await maintenance.close();
  });
});
