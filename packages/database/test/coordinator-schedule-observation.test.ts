import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { observeScheduleToStartSeconds } from '../src/execution/coordinator-schedule-observation.js';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function rejectUndefined<T>(): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Verifies normalization of a hostile non-Error rejection.
  return Promise.reject(undefined);
}

function result(observedAt?: Date): QueryResult<{ observed_at: Date }> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: observedAt === undefined ? 0 : 1,
    rows: observedAt === undefined ? [] : [{ observed_at: observedAt }],
  };
}

function fakeClient(
  query: () => Promise<QueryResult<{ observed_at: Date }>>,
): Readonly<{
  client: PoolClient;
  release: ReturnType<typeof vi.fn>;
}> {
  const release = vi.fn();
  return {
    client: { query, release } as unknown as PoolClient,
    release,
  };
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

describe('coordinator schedule observation', () => {
  it('returns the database-observed duration and releases the client', async () => {
    const { client, release } = fakeClient(() =>
      Promise.resolve(result(new Date('2026-09-13T00:00:04.250Z'))),
    );

    await expect(
      observeScheduleToStartSeconds(
        fakePool(() => Promise.resolve(client)),
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        50,
      ),
    ).resolves.toBe(4.25);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    ['missing row', undefined],
    ['invalid date', new Date(Number.NaN)],
  ])('omits the metric for a %s', async (_name, observedAt) => {
    const { client, release } = fakeClient(() =>
      Promise.resolve(result(observedAt)),
    );

    await expect(
      observeScheduleToStartSeconds(
        fakePool(() => Promise.resolve(client)),
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        50,
      ),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledWith();
  });

  it.each([
    ['checkout rejects', 'checkout'],
    ['query rejects', 'query'],
  ])('contains a diagnostic %s failure', async (_name, phase) => {
    const { client, release } = fakeClient(() => rejectUndefined());
    const pool = fakePool(() =>
      phase === 'checkout' ? rejectUndefined() : Promise.resolve(client),
    );

    await expect(
      observeScheduleToStartSeconds(
        pool,
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        50,
      ),
    ).resolves.toBeUndefined();
    if (phase === 'checkout') expect(release).not.toHaveBeenCalled();
    else expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('discards an active query on caller abort and observes late settlement', async () => {
    const pending = deferred<QueryResult<{ observed_at: Date }>>();
    const queryStarted = deferred<undefined>();
    const { client, release } = fakeClient(() => {
      queryStarted.resolve(undefined);
      return pending.promise;
    });
    const controller = new AbortController();
    const observation = observeScheduleToStartSeconds(
      fakePool(() => Promise.resolve(client)),
      '2026-09-13T00:00:00.000Z',
      controller.signal,
      1_000,
    );
    await queryStarted.promise;
    controller.abort();

    await expect(observation).resolves.toBeUndefined();
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    pending.resolve(result(new Date('2026-09-13T00:00:01.000Z')));
    await pending.promise;
  });

  it('bounds checkout and active-query ownership by the metric deadline', async () => {
    const checkout = deferred<PoolClient>();
    await expect(
      observeScheduleToStartSeconds(
        fakePool(() => checkout.promise),
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        10,
      ),
    ).resolves.toBeUndefined();
    const late = fakeClient(() => Promise.resolve(result()));
    checkout.resolve(late.client);
    await checkout.promise;
    await vi.waitFor(() => {
      expect(late.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    const query = deferred<QueryResult<{ observed_at: Date }>>();
    const active = fakeClient(() => query.promise);
    await expect(
      observeScheduleToStartSeconds(
        fakePool(() => Promise.resolve(active.client)),
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        10,
      ),
    ).resolves.toBeUndefined();
    expect(active.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    query.reject(new Error('late socket settlement'));
    await expect(query.promise).rejects.toThrow('late socket settlement');
  });

  it('releases a held observation so pool shutdown can finish', async () => {
    const query = deferred<QueryResult<{ observed_at: Date }>>();
    const queryStarted = deferred<undefined>();
    const released = deferred<undefined>();
    const release = vi.fn((error?: boolean | Error) => {
      void error;
      released.resolve(undefined);
    });
    const client = {
      query: () => {
        queryStarted.resolve(undefined);
        return query.promise;
      },
      release,
    } as unknown as PoolClient;
    const pool = {
      connect: () => Promise.resolve(client),
      end: () => released.promise,
    } as unknown as Pool;
    const observation = observeScheduleToStartSeconds(
      pool,
      '2026-09-13T00:00:00.000Z',
      new AbortController().signal,
      10,
    );
    await queryStarted.promise;
    const shutdown = pool.end();

    await expect(Promise.all([observation, shutdown])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    query.resolve(result());
    await query.promise;
  });

  it('omits the metric for an invalid internal deadline', async () => {
    await expect(
      observeScheduleToStartSeconds(
        fakePool(() => Promise.reject(new Error('must not connect'))),
        '2026-09-13T00:00:00.000Z',
        new AbortController().signal,
        0,
      ),
    ).resolves.toBeUndefined();
  });
});
