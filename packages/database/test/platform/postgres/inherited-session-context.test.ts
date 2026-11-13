import { beforeEach, describe, expect, it, vi } from 'vitest';

import { beforeEachFixture1, pg, poolAt } from './telemetry/fixture.js';
import { InheritedSessionContextError } from '../../../src/platform/index.js';
import { createDatabasePool } from '../../../src/platform/pool/telemetry/create-pool.js';

const client = () => ({ release: vi.fn() });

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
    'refuses every %s checkout, naming the settings, after inspecting its first client',
    async (role) => {
      pg.FakePool.freshSession = {
        kind: 'carries',
        settings: ['app.organization_id', 'app.workspace_id'],
      };
      const first = client();
      pg.FakePool.connectOutcomes.push(
        { kind: 'resolve', client: first },
        { kind: 'resolve', client: client() },
      );
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

      // The inspected client is destroyed, and no other connection opened.
      expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(poolAt(0).inspections).toBe(1);
      expect(pg.FakePool.connectOutcomes).toHaveLength(1);
    },
  );
});

describe('a pool whose fresh session is clean', () => {
  beforeEach(beforeEachFixture1);

  it("inspects the caller's own first client once and takes no checkout of its own", async () => {
    const first = client();
    // Telemetry wraps a handed-out client's release; keep the original.
    const firstRelease = first.release;
    const second = client();
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client: first },
      { kind: 'resolve', client: second },
    );
    const target = pool();

    await expect(target.connect()).resolves.toBe(first);
    await expect(callbackCheckout(target)).resolves.toBe('connected');
    expect(pg.FakePool.connectOutcomes).toHaveLength(0);
    expect(firstRelease).not.toHaveBeenCalled();
    expect(poolAt(0).inspections).toBe(1);
  });

  it('shares one inspection between checkouts that start together', async () => {
    const first = client();
    const second = client();
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client: first },
      { kind: 'resolve', client: second },
    );
    const target = pool();

    await expect(
      Promise.all([target.connect(), target.connect()]),
    ).resolves.toEqual([first, second]);
    expect(poolAt(0).inspections).toBe(1);
  });

  it('destroys a client it could not inspect and inspects the next', async () => {
    pg.FakePool.freshSession = {
      kind: 'unreachable',
      error: new Error('connection lost'),
    };
    const lost = client();
    pg.FakePool.connectOutcomes.push({ kind: 'resolve', client: lost });
    const target = pool();
    await expect(target.connect()).rejects.toThrow('connection lost');
    expect(lost.release).toHaveBeenCalledExactlyOnceWith(true);

    pg.FakePool.freshSession = { kind: 'clean' };
    const ready = client();
    pg.FakePool.connectOutcomes.push({ kind: 'resolve', client: ready });
    await expect(target.connect()).resolves.toBe(ready);
    expect(poolAt(0).inspections).toBe(2);
  });
});

describe('checkouts that start together on a new pool', () => {
  beforeEach(beforeEachFixture1);

  it('refuses every one of them when the shared inspection finds a setting', async () => {
    pg.FakePool.freshSession = {
      kind: 'carries',
      settings: ['app.workspace_id'],
    };
    const first = client();
    const second = client();
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client: first },
      { kind: 'resolve', client: second },
    );
    const target = pool();

    const outcomes = await Promise.all([
      target.connect().catch((error: unknown) => error),
      target.connect().catch((error: unknown) => error),
    ]);

    expect(outcomes[0]).toBeInstanceOf(InheritedSessionContextError);
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(poolAt(0).inspections).toBe(1);
  });

  it('fails only the checkout whose client could not be inspected', async () => {
    const lost = new Error('connection lost');
    let reads = 0;
    Object.defineProperty(pg.FakePool, 'freshSession', {
      configurable: true,
      get: () =>
        reads++ === 0
          ? { kind: 'unreachable', error: lost }
          : { kind: 'clean' },
    });
    const first = client();
    const second = client();
    pg.FakePool.connectOutcomes.push(
      { kind: 'resolve', client: first },
      { kind: 'resolve', client: second },
    );
    const target = pool();
    try {
      const outcomes = await Promise.allSettled([
        target.connect(),
        target.connect(),
      ]);
      expect(outcomes[0]).toEqual({ status: 'rejected', reason: lost });
      expect(outcomes[1]).toEqual({ status: 'fulfilled', value: second });
      expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(poolAt(0).inspections).toBe(2);
    } finally {
      Object.defineProperty(pg.FakePool, 'freshSession', {
        configurable: true,
        writable: true,
        value: { kind: 'clean' },
      });
    }
  });
});
