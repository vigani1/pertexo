import { beforeEach, describe, expect, it } from 'vitest';

import { beforeEachFixture1, pg, poolAt } from './telemetry/fixture.js';
import { InheritedSessionContextError } from '../../../src/platform/index.js';
import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';

const client = () => ({ release: () => undefined });

function pool(role: 'api' | 'maintenance' | 'worker' = 'api') {
  return createDatabasePool({ max: 2 }, { monitorLockWaits: false, role });
}

function callbackCheckout(target: ReturnType<typeof pool>) {
  return new Promise<unknown>((resolve) => {
    target.connect((error) => {
      resolve(error ?? 'connected');
    });
  });
}

describe('a pool whose fresh session carries app settings', () => {
  beforeEach(beforeEachFixture1);

  it.each(['api', 'worker', 'maintenance'] as const)(
    'refuses every %s checkout, naming the settings, after one inspection',
    async (role) => {
      pg.FakePool.freshSession = {
        kind: 'carries',
        settings: ['app.organization_id', 'app.workspace_id'],
      };
      pg.FakePool.connectOutcomes.push({ kind: 'resolve', client: client() });
      const target = pool(role);

      const refusal = await target.connect().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(InheritedSessionContextError);
      expect(refusal).toMatchObject({
        role,
        settings: ['app.organization_id', 'app.workspace_id'],
      });
      expect(String(refusal)).toContain(
        'app.organization_id, app.workspace_id',
      );
      await expect(target.connect()).rejects.toBe(refusal);
      await expect(callbackCheckout(target)).resolves.toBe(refusal);

      // The inspected connection is destroyed, and no other session opened.
      expect(poolAt(0).freshSessionChecks).toEqual([{ destroyed: true }]);
      expect(pg.FakePool.connectOutcomes).toHaveLength(1);
    },
  );
});

describe('a pool whose fresh session is clean', () => {
  beforeEach(beforeEachFixture1);

  it('inspects once and then hands out clients through both checkout forms', async () => {
    const first = client();
    const second = client();
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client: first },
      { kind: 'resolve', client: second },
    );
    const target = pool();

    await expect(target.connect()).resolves.toBe(first);
    await expect(callbackCheckout(target)).resolves.toBe('connected');
    expect(poolAt(0).freshSessionChecks).toEqual([{ destroyed: undefined }]);
  });

  it('retries the inspection after the database could not be reached', async () => {
    pg.FakePool.freshSession = {
      kind: 'unreachable',
      error: new Error('connection refused'),
    };
    const target = pool();
    await expect(target.connect()).rejects.toThrow('connection refused');

    pg.FakePool.freshSession = { kind: 'clean' };
    const ready = client();
    pg.FakePool.connectOutcomes.push({ kind: 'resolve', client: ready });
    await expect(target.connect()).resolves.toBe(ready);
    expect(poolAt(0).freshSessionChecks).toHaveLength(1);
  });
});
