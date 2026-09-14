import { describe, expect, it, vi } from 'vitest';

import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from './fixture-resource-owner.js';

function resource(
  name: string,
  close: () => void | Promise<void> = vi.fn<() => void>(),
) {
  return { name, close };
}

describe('FixtureResourceOwner', () => {
  const rolloutOwnerNames = [
    'compatibility maintenance',
    'current API probe',
    'current worker probe',
    'predecessor API probe',
    'staging API probe',
    'staging worker probe',
    'activation API probe',
    'activation worker probe',
    'identity database',
    'current authoring database',
    'staging authoring database',
    'activation authoring database',
    'connection database',
    'integration usage database',
    'activation run persistence',
  ] as const;

  it.each([
    ['identity database acquisition', 0],
    ['identity resolution', 1],
    ['OIDC transaction acquisition', 2],
    ['second store allocation', 3],
    ['application construction', 4],
    ['application initialization', 5],
  ] as const)(
    'closes all and only acquired resources after %s failure',
    async (_case, acquiredCount) => {
      const owner = new FixtureResourceOwner();
      const allocated = Array.from({ length: acquiredCount }, (_, index) =>
        resource(`resource-${String(index)}`),
      );
      for (const selected of allocated)
        owner.acquire(selected.name, selected, (value) => value.close());
      const neverAcquired = resource('never-acquired');
      const setupFailure = new Error('setup failed');

      await expect(
        rethrowFixtureSetupFailure(owner, setupFailure),
      ).rejects.toBe(setupFailure);
      await owner.close();

      for (const selected of allocated)
        expect(selected.close).toHaveBeenCalledOnce();
      expect(neverAcquired.close).not.toHaveBeenCalled();
    },
  );

  it('transfers nested owners and closes remaining resources in reverse order', async () => {
    const owner = new FixtureResourceOwner();
    const order: string[] = [];
    const database = resource('database', () => {
      order.push('database');
    });
    const runtime = resource('runtime', () => {
      order.push('runtime');
    });
    const application = resource('application', () => {
      order.push('application');
    });
    owner.acquire(database.name, database, (value) => value.close());
    owner.acquire(runtime.name, runtime, (value) => value.close());
    owner.transfer(database);
    owner.acquire(application.name, application, (value) => value.close());

    await owner.close();

    expect(order).toEqual(['application', 'runtime']);
  });

  it.each(
    rolloutOwnerNames.map((name, failedIndex) => [name, failedIndex] as const),
  )(
    'rolls back only compatibility owners acquired before %s fails',
    async (_failedName, failedIndex) => {
      const owner = new FixtureResourceOwner();
      const resources = rolloutOwnerNames.map((name) => resource(name));
      for (const selected of resources.slice(0, failedIndex))
        owner.acquire(selected.name, selected, (value) => value.close());

      const setupFailure = new Error(
        'injected compatibility acquisition failure',
      );
      await expect(
        rethrowFixtureSetupFailure(owner, setupFailure),
      ).rejects.toBe(setupFailure);

      for (const [index, selected] of resources.entries()) {
        if (index < failedIndex) {
          expect(selected.close).toHaveBeenCalledOnce();
        } else {
          expect(selected.close).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each([
    'identity database',
    'OIDC transaction store',
    'identity runtime',
    'workspace database',
    'owner pool',
    'API verification pool',
    'API application',
  ] as const)(
    'releases the lifecycle fixture ownership graph after failure following %s acquisition',
    async (failurePoint) => {
      const owner = new FixtureResourceOwner();
      const closed: string[] = [];
      const identityDatabase = resource('identity database', () => {
        closed.push('identity database');
      });
      const transactions = resource('OIDC transaction store', () => {
        closed.push('OIDC transaction store');
      });
      const identityRuntime = resource('identity runtime', async () => {
        closed.push('identity runtime');
        await transactions.close();
        await identityDatabase.close();
      });
      const remaining = [
        resource('workspace database', () => {
          closed.push('workspace database');
        }),
        resource('owner pool', () => {
          closed.push('owner pool');
        }),
        resource('API verification pool', () => {
          closed.push('API verification pool');
        }),
        resource('API application', () => {
          closed.push('API application');
        }),
      ] as const;

      owner.acquire(identityDatabase.name, identityDatabase, (value) =>
        value.close(),
      );
      if (failurePoint !== identityDatabase.name) {
        owner.acquire(transactions.name, transactions, (value) =>
          value.close(),
        );
        if (failurePoint !== transactions.name) {
          owner.transfer(identityDatabase);
          owner.transfer(transactions);
          owner.acquire(identityRuntime.name, identityRuntime, (value) =>
            value.close(),
          );
          if (failurePoint !== identityRuntime.name) {
            for (const selected of remaining) {
              owner.acquire(selected.name, selected, (value) => value.close());
              if (failurePoint === selected.name) break;
            }
          }
        }
      }

      const setupFailure = new Error(`failed after ${failurePoint}`);
      await expect(
        rethrowFixtureSetupFailure(owner, setupFailure),
      ).rejects.toBe(setupFailure);

      const expected = [
        ...(failurePoint === 'API application' ? ['API application'] : []),
        ...(['API verification pool', 'API application'].includes(failurePoint)
          ? ['API verification pool']
          : []),
        ...((
          ['owner pool', 'API verification pool', 'API application'] as string[]
        ).includes(failurePoint)
          ? ['owner pool']
          : []),
        ...((
          [
            'workspace database',
            'owner pool',
            'API verification pool',
            'API application',
          ] as string[]
        ).includes(failurePoint)
          ? ['workspace database']
          : []),
        ...(failurePoint === 'identity database'
          ? ['identity database']
          : failurePoint === 'OIDC transaction store'
            ? ['OIDC transaction store', 'identity database']
            : [
                'identity runtime',
                'OIDC transaction store',
                'identity database',
              ]),
      ];
      expect(closed).toEqual(expected);
    },
  );

  it('waits for a held cleanup barrier before closing the next owner', async () => {
    const owner = new FixtureResourceOwner();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = resource('first', () => {
      order.push('first');
    });
    const second = resource('second', async () => {
      order.push('second:start');
      await held;
      order.push('second:end');
    });
    owner.acquire(first.name, first, (value) => value.close());
    owner.acquire(second.name, second, (value) => value.close());

    const closing = owner.close();
    await vi.waitFor(() => {
      expect(order).toEqual(['second:start']);
    });
    release();
    await closing;

    expect(order).toEqual(['second:start', 'second:end', 'first']);
  });

  it('aggregates synchronous and asynchronous close failures with setup failure once', async () => {
    const owner = new FixtureResourceOwner();
    const setupFailure = new Error('application failed');
    const firstFailure = new Error('pool close rejected');
    const secondFailure = new Error('store close threw');
    const first = resource(
      'pool',
      vi.fn<() => Promise<void>>().mockRejectedValue(firstFailure),
    );
    const second = resource(
      'store',
      vi.fn<() => void>(() => {
        throw secondFailure;
      }),
    );
    owner.acquire(first.name, first, (value) => value.close());
    owner.acquire(second.name, second, (value) => value.close());

    const rejection = rethrowFixtureSetupFailure(owner, setupFailure);
    await expect(rejection).rejects.toMatchObject({
      errors: [setupFailure, secondFailure, firstFailure],
    });
    await expect(owner.close()).rejects.toMatchObject({
      errors: [secondFailure, firstFailure],
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });
});
