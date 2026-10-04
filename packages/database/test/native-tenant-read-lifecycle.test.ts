import { EventEmitter } from 'node:events';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withTenantScopedReadClient } from '../src/tenant-access/workspace.js';
import { withCoordinatorReadClient } from '../src/execution/coordinator/coordinator-run-store-transactions.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function checkoutAdapter(checkout: Promise<PoolClient>) {
  return (
    callback: (error: Error | undefined, client?: PoolClient) => void,
  ): void => {
    void checkout.then(
      (client) => {
        callback(undefined, client);
      },
      (error: unknown) => {
        callback(
          error instanceof Error
            ? error
            : new Error('Checkout failed', { cause: error }),
        );
      },
    );
  };
}

describe('native tenant read operation and joined ownership', () => {
  it.each([
    { stop: 'abort', phase: 'rollback' },
    { stop: 'deadline', phase: 'rollback' },
    { stop: 'abort', phase: 'hygiene' },
    { stop: 'deadline', phase: 'hygiene' },
  ] as const)(
    'does not issue more SQL or release twice after $stop interrupts $phase that later succeeds',
    async ({ stop, phase }) => {
      let monotonic = 0;
      const clock =
        stop === 'deadline'
          ? vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
          : undefined;
      const controller = new AbortController();
      const rollbackStarted = Promise.withResolvers<undefined>();
      const rollback = Promise.withResolvers<{ rows: never[] }>();
      const client = new EventEmitter();
      const release = vi.fn();
      const destroy = vi.fn();
      const original = new TypeError('Independent source failure');
      let scoped = false;
      let rolledBack = false;
      let timeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql === 'rollback') {
          if (phase === 'rollback') {
            rollbackStarted.resolve(undefined);
            return rollback.promise;
          }
          rolledBack = true;
          scoped = false;
        }
        if (rolledBack && sql.includes("current_setting('app.workspace_id'")) {
          rollbackStarted.resolve(undefined);
          return rollback.promise;
        }
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        if (sql.includes("set_config('statement_timeout'"))
          timeout = Number.parseInt(String(values?.[0]), 10);
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: timeout,
            },
          ],
        });
      });
      Object.assign(client, {
        query,
        release,
        connection: { stream: { destroy } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(
          Promise.resolve(client as unknown as PoolClient),
        ),
      } as unknown as Pool;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.reject(original),
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ).catch((error: unknown) => error);
      try {
        await rollbackStarted.promise;
        if (stop === 'abort') controller.abort();
        else monotonic = 251;
        const queriesBeforeRollbackSettlement = query.mock.calls.length;
        rollback.resolve({ rows: [] });
        client.emit('end');
        const result: unknown = await pending;
        expect(query.mock.calls).toHaveLength(queriesBeforeRollbackSettlement);
        expect(result).toBe(original);
        expect(release).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
        rollback.resolve({ rows: [] });
        client.emit('end');
        await pending;
        clock?.mockRestore();
      }
    },
  );

  it.each([
    { cleanup: 'rollback', interrupt: false },
    { cleanup: 'hygiene', interrupt: false },
    { cleanup: 'rollback', interrupt: true },
    { cleanup: 'hygiene', interrupt: true },
  ] as const)(
    'joins destruction and preserves operation plus $cleanup failure (interrupted $interrupt)',
    async ({ cleanup, interrupt }) => {
      const controller = new AbortController();
      let queriesAtAbort: number | undefined;
      const client = new EventEmitter();
      const operationFailure = new TypeError('Native source integrity failed');
      const cleanupFailure = new Error('Native cleanup failed');
      const release = vi.fn();
      const destroy = vi.fn();
      let scoped = false;
      let rolledBack = false;
      let statementTimeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql === 'rollback') {
          if (cleanup === 'rollback') {
            if (interrupt) {
              controller.abort();
              queriesAtAbort = query.mock.calls.length;
            }
            return Promise.reject(cleanupFailure);
          }
          scoped = false;
          rolledBack = true;
        }
        if (rolledBack && sql.includes("current_setting('app.workspace_id'")) {
          if (interrupt) {
            controller.abort();
            queriesAtAbort = query.mock.calls.length;
          }
          return Promise.reject(cleanupFailure);
        }
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        if (sql.includes("set_config('statement_timeout'"))
          statementTimeout = Number.parseInt(String(values?.[0]), 10);
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: statementTimeout,
            },
          ],
        });
      });
      Object.assign(client, {
        query,
        release,
        connection: { stream: { destroy } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(
          Promise.resolve(client as unknown as PoolClient),
        ),
      } as unknown as Pool;
      let settled = false;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.reject(operationFailure),
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(release).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        client.emit('end');
        const result: unknown = await pending;
        expect(result).toBeInstanceOf(AggregateError);
        if (!(result instanceof AggregateError))
          throw new Error('Expected mixed failure');
        expect(result.errors).toEqual([operationFailure, cleanupFailure]);
        if (interrupt)
          expect(query.mock.calls).toHaveLength(queriesAtAbort ?? -1);
        expect(destroy).toHaveBeenCalledOnce();
        expect(client.listenerCount('end')).toBe(0);
      } finally {
        client.emit('end');
        await pending;
      }
    },
  );

  it('preserves actual coordinator-to-tenant read composition without native budget opt-in', async () => {
    const client = new EventEmitter();
    const release = vi.fn();
    let scoped = false;
    const query = vi.fn((sql: string) => {
      if (sql.includes("set_config('app.workspace_id'")) scoped = true;
      if (sql === 'commit') scoped = false;
      return Promise.resolve({
        rows: [
          {
            workspace_id: scoped ? workspaceId : null,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: 0,
          },
        ],
      });
    });
    Object.assign(client, { release, query });
    const pool = {
      options: { connectionTimeoutMillis: 5_000 },
      connect: () => Promise.resolve(client as unknown as PoolClient),
    } as unknown as Pool;
    await expect(
      withCoordinatorReadClient(
        pool,
        workspaceId,
        new AbortController().signal,
        () => Promise.resolve('retained'),
      ),
    ).resolves.toBe('retained');
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      'begin isolation level repeatable read read only',
    );
    expect(query.mock.calls.map(([sql]) => sql)).toContain('commit');
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("set_config('statement_timeout'"),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });

  it('owns a client delivered and terminated synchronously while checkout aborts', async () => {
    const controller = new AbortController();
    const client = new EventEmitter();
    const release = vi.fn();
    const query = vi.fn();
    const destroy = vi.fn();
    Object.assign(client, {
      release,
      query,
      connection: { stream: { destroy } },
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: (
        callback: (error: Error | undefined, connection: PoolClient) => void,
      ) => {
        callback(undefined, client as unknown as PoolClient);
        client.emit('end');
        controller.abort();
      },
    } as unknown as Pool;
    await expect(
      withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.resolve('unreachable'),
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(client.listenerCount('end')).toBe(0);
  });

  it('joins a client terminal event that occurred before cancellation disposal', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const operation = Promise.withResolvers<string>();
    const client = new EventEmitter();
    let scoped = false;
    let timeout = 0;
    Object.assign(client, {
      release: vi.fn(),
      connection: { stream: { destroy: vi.fn() } },
      query: (sql: string, values?: readonly unknown[]) => {
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        if (sql.includes("set_config('statement_timeout'"))
          timeout = Number.parseInt(String(values?.[0]), 10);
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: timeout,
            },
          ],
        });
      },
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: checkoutAdapter(
        Promise.resolve(client as unknown as PoolClient),
      ),
    } as unknown as Pool;
    let settled = false;
    const pending = withTenantScopedReadClient(
      pool,
      { workspaceId },
      () => {
        started.resolve(undefined);
        return operation.promise;
      },
      {
        signal: controller.signal,
        nativeReadBudget: {
          readTimeoutMillis: 250,
          controlReadTimeoutMillis: 250,
        },
      },
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await started.promise;
      client.emit('end');
      controller.abort();
      operation.resolve('late');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(client.listenerCount('end')).toBe(0);
    } finally {
      controller.abort();
      operation.resolve('late');
      client.emit('end');
      await pending;
    }
  });

  it('rejects post-commit hygiene completed after the monotonic deadline even before timers run', async () => {
    let monotonic = 0;
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonic);
    const client = new EventEmitter();
    const release = vi.fn();
    let scoped = false;
    let committed = false;
    let statementTimeout = 0;
    const query = vi.fn((sql: string, values?: readonly unknown[]) => {
      if (sql.includes("set_config('app.workspace_id'")) scoped = true;
      if (sql.includes("set_config('statement_timeout'"))
        statementTimeout = Number.parseInt(String(values?.[0]), 10);
      if (sql === 'commit') {
        committed = true;
        scoped = false;
      }
      if (committed && sql.includes("current_setting('app.workspace_id'"))
        monotonic = 251;
      return Promise.resolve({
        rows: [
          {
            workspace_id: scoped ? workspaceId : null,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: statementTimeout,
          },
        ],
      });
    });
    Object.assign(client, {
      query,
      release,
      connection: {
        stream: {
          destroy: () => {
            client.emit('end');
          },
        },
      },
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: checkoutAdapter(
        Promise.resolve(client as unknown as PoolClient),
      ),
    } as unknown as Pool;
    try {
      await expect(
        withTenantScopedReadClient(
          pool,
          { workspaceId },
          () => Promise.resolve('late value'),
          {
            nativeReadBudget: {
              readTimeoutMillis: 250,
              controlReadTimeoutMillis: 250,
            },
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(release).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ name: 'AbortError' }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['timer', 'monotonic'] as const)(
    'retains ownership after cleanup allowance exhaustion and reports operational failure after joining (%s)',
    async (expiry) => {
      vi.useFakeTimers();
      let monotonic = 0;
      const clock =
        expiry === 'monotonic'
          ? vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
          : undefined;
      const checkout = Promise.withResolvers<PoolClient>();
      const controller = new AbortController();
      const client = new EventEmitter();
      Object.assign(client, {
        release: vi.fn(),
        query: vi.fn(),
        connection: { stream: { destroy: vi.fn() } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(checkout.promise),
      } as unknown as Pool;
      let settled = false;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.resolve('unreachable'),
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        controller.abort();
        if (expiry === 'timer') await vi.advanceTimersByTimeAsync(2_501);
        else monotonic = 2_501;
        expect(settled).toBe(false);
        checkout.resolve(client as unknown as PoolClient);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        client.emit('end');
        const result: unknown = await pending;
        expect(result).toBeInstanceOf(AggregateError);
        if (!(result instanceof AggregateError))
          throw new Error('Expected operational cleanup failure');
        expect(result.errors).toEqual([
          expect.objectContaining({ name: 'AbortError' }),
          expect.objectContaining({
            message: 'Native read joined-cleanup deadline exceeded',
          }),
        ]);
        expect(vi.getTimerCount()).toBe(0);
        expect(client.listenerCount('end')).toBe(0);
      } finally {
        checkout.resolve(client as unknown as PoolClient);
        await vi.advanceTimersByTimeAsync(0);
        client.emit('end');
        await pending;
        clock?.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('destroys a late client and preserves cancellation setup failure', async () => {
    const checkout = Promise.withResolvers<PoolClient>();
    const controller = new AbortController();
    const setupFailure = new TypeError('Cancellation transport setup failed');
    const client = new EventEmitter();
    const release = vi.fn();
    const destroy = vi.fn();
    Object.assign(client, {
      release,
      connection: { stream: { destroy } },
      _getActiveQuery: () => {
        throw setupFailure;
      },
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: checkoutAdapter(checkout.promise),
    } as unknown as Pool;
    const pending = withTenantScopedReadClient(
      pool,
      { workspaceId },
      () => Promise.resolve('unreachable'),
      {
        signal: controller.signal,
        nativeReadBudget: {
          readTimeoutMillis: 250,
          controlReadTimeoutMillis: 250,
        },
      },
    ).catch((error: unknown) => error);
    try {
      controller.abort();
      checkout.resolve(client as unknown as PoolClient);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(release).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      client.emit('end');
      const result: unknown = await pending;
      expect(result).toBeInstanceOf(AggregateError);
      if (!(result instanceof AggregateError))
        throw new Error('Expected cleanup failure');
      const disposal: unknown = result.errors[1];
      expect(disposal).toBeInstanceOf(AggregateError);
      if (!(disposal instanceof AggregateError))
        throw new Error('Expected disposal failure');
      expect(disposal.errors).toContain(setupFailure);
    } finally {
      checkout.resolve(client as unknown as PoolClient);
      client.emit('end');
      await pending;
    }
  });

  it('refuses incompatible actual pool acquisition settings before checkout', async () => {
    const connect = vi.fn(() => {
      throw new Error('Unexpected checkout before configuration admission');
    });
    const pool = {
      options: { connectionTimeoutMillis: 5_000 },
      connect,
    } as unknown as Pool;
    const options = {
      signal: new AbortController().signal,
      nativeReadBudget: {
        readTimeoutMillis: 2_000,
        controlReadTimeoutMillis: 2_000,
      },
    };
    await expect(
      withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.resolve('unreachable'),
        options,
      ),
    ).rejects.toThrow(
      'Pool acquisition bound exceeds native read operation budget',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('joins raw checkout and delivered late-client termination after abort', async () => {
    const checkout = Promise.withResolvers<PoolClient>();
    const controller = new AbortController();
    const client = new EventEmitter();
    const destroy = vi.fn();
    const release = vi.fn();
    const query = vi.fn();
    Object.assign(client, {
      release,
      query,
      connection: { stream: { destroy } },
    });
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect: checkoutAdapter(checkout.promise),
    } as unknown as Pool;
    const operation = vi.fn(() => Promise.resolve('must not run'));
    let settled = false;
    const pending = withTenantScopedReadClient(
      pool,
      { workspaceId },
      operation,
      {
        signal: controller.signal,
        nativeReadBudget: {
          readTimeoutMillis: 250,
          controlReadTimeoutMillis: 250,
        },
      },
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      controller.abort(new Error('native read canceled'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      checkout.resolve(client as unknown as PoolClient);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      client.emit('end');
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(operation).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(client.listenerCount('end')).toBe(0);
    } finally {
      checkout.resolve(client as unknown as PoolClient);
      await new Promise<void>((resolve) => setImmediate(resolve));
      client.emit('end');
      await pending;
    }
  });

  it.each([false, true])(
    'expires usable operation time without returning before query and client termination join (same abort release %s)',
    async (sameAbortRelease) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const queryFinished = Promise.withResolvers<{ rows: never[] }>();
      const client = new EventEmitter();
      const destroy = vi.fn();
      const release = vi.fn((error?: Error) => {
        if (sameAbortRelease)
          throw error ?? new Error('Expected release cancellation');
      });
      let scoped = false;
      let statementTimeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql === 'select protected_native_source')
          return queryFinished.promise;
        if (sql.includes("set_config('statement_timeout'"))
          statementTimeout = Number.parseInt(String(values?.[0]), 10);
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        if (sql === 'commit' || sql === 'rollback') scoped = false;
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: statementTimeout,
            },
          ],
        });
      });
      Object.assign(client, {
        query,
        release,
        connection: { stream: { destroy } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(
          Promise.resolve(client as unknown as PoolClient),
        ),
      } as unknown as Pool;
      let settled = false;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        async (connection) => {
          await connection.query('select protected_native_source');
          return 'late value';
        },
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(251);
        expect(destroy).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        queryFinished.resolve({ rows: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        client.emit('end');
        expect(await pending).toMatchObject({ name: 'AbortError' });
        expect(query.mock.calls.map(([sql]) => sql)).not.toContain('commit');
        expect(query.mock.calls.map(([sql]) => sql)).not.toContain('rollback');
        expect(client.listenerCount('end')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        queryFinished.resolve({ rows: [] });
        client.emit('end');
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it('keeps dequeued construction pool-owned when the queued checkout times out before delivery', async () => {
    vi.useFakeTimers();
    const clients: ControlledClient[] = [];
    let finishConstruction: (() => void) | undefined;
    class ControlledClient extends EventEmitter {
      public readonly queries: string[] = [];
      public readonly _queryable = true;
      public readonly _ending = false;
      public readonly connection = {
        stream: { destroy: () => this.emit('end') },
      };
      public constructor() {
        super();
        clients.push(this);
      }
      public connect(callback: (error?: Error) => void): void {
        if (clients.length === 1) callback();
        else
          finishConstruction = () => {
            callback();
          };
      }
      public query(sql: string): Promise<{ rows: never[] }> {
        this.queries.push(sql);
        return Promise.resolve({ rows: [] });
      }
      public end(callback?: () => void): void {
        this.emit('end');
        callback?.();
      }
    }
    const config = {
      max: 1,
      connectionTimeoutMillis: 40,
      Client: ControlledClient as unknown as NonNullable<PoolConfig['Client']>,
    };
    const pool = new Pool(config);
    const controller = new AbortController();
    const held = await pool.connect();
    const operation = vi.fn(() => Promise.resolve('never'));
    const pending = withTenantScopedReadClient(
      pool,
      { workspaceId },
      operation,
      {
        signal: controller.signal,
        nativeReadBudget: {
          readTimeoutMillis: 100,
          controlReadTimeoutMillis: 100,
        },
      },
    ).catch((error: unknown) => error);
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      held.release(new Error('Replace the held fixture connection'));
      expect(finishConstruction).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(31);
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(operation).not.toHaveBeenCalled();
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(0);
      expect(pool.ending).toBe(false);
      // This construction was not delivered to the read. The pool owns its
      // late completion and idle release; the read must not destroy that pool.
      finishConstruction?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.idleCount).toBe(1);
      expect(clients.flatMap((client) => client.queries)).toEqual([]);
      expect(vi.getTimerCount()).toBe(1); // Existing pool-owned idle timeout only.
    } finally {
      finishConstruction?.();
      await pending;
      await pool.end();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'preserves an independent integrity failure even when cancellation also occurs (release failure %s)',
    async (releaseFails) => {
      const controller = new AbortController();
      const started = Promise.withResolvers<undefined>();
      const operation = Promise.withResolvers<string>();
      const client = new EventEmitter();
      const releaseFailure = new Error('Pool release bookkeeping failed');
      let scoped = false;
      let statementTimeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql.includes("set_config('statement_timeout'"))
          statementTimeout = Number.parseInt(String(values?.[0]), 10);
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: statementTimeout,
            },
          ],
        });
      });
      Object.assign(client, {
        query,
        release: vi.fn(() => {
          if (releaseFails) throw releaseFailure;
        }),
        connection: { stream: { destroy: vi.fn() } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(
          Promise.resolve(client as unknown as PoolClient),
        ),
      } as unknown as Pool;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => {
          started.resolve(undefined);
          return operation.promise;
        },
        {
          signal: controller.signal,
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      ).catch((error: unknown) => error);
      const integrityFailure = new TypeError(
        'Accepted source bytes do not match',
      );
      try {
        await started.promise;
        controller.abort();
        operation.reject(integrityFailure);
        client.emit('end');
        const result: unknown = await pending;
        if (!releaseFails) expect(result).toBe(integrityFailure);
        else {
          expect(result).toBeInstanceOf(AggregateError);
          if (!(result instanceof AggregateError))
            throw new Error('Expected mixed cleanup failure');
          expect(result.errors[0]).toBe(integrityFailure);
          const disposal: unknown = result.errors[1];
          expect(disposal).toBeInstanceOf(AggregateError);
          if (!(disposal instanceof AggregateError))
            throw new Error('Expected release failure');
          expect(disposal.errors).toEqual([releaseFailure]);
        }
      } finally {
        operation.resolve('unused');
        controller.abort();
        client.emit('end');
        await pending;
      }
    },
  );

  it.each([20_000, undefined])(
    'uses only remaining monotonic operation time for SQL statement timeout (configured %s)',
    async (configuredTimeout) => {
      let monotonic = 0;
      const clock = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => monotonic);
      const checkout = Promise.withResolvers<PoolClient>();
      const client = new EventEmitter();
      const release = vi.fn();
      let scoped = false;
      let statementTimeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql.includes("set_config('app.workspace_id'")) scoped = true;
        if (sql.includes("set_config('statement_timeout'"))
          statementTimeout = Number.parseInt(String(values?.[0]), 10);
        if (sql === 'commit' || sql === 'rollback') scoped = false;
        return Promise.resolve({
          rows: [
            {
              workspace_id: scoped ? workspaceId : null,
              actor_id: null,
              discovery_scope: null,
              statement_timeout_millis: statementTimeout,
            },
          ],
        });
      });
      Object.assign(client, { query, release });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: checkoutAdapter(checkout.promise),
      } as unknown as Pool;
      const pending = withTenantScopedReadClient(
        pool,
        { workspaceId },
        () => Promise.resolve('bounded'),
        {
          ...(configuredTimeout === undefined
            ? {}
            : { statementTimeoutMillis: configuredTimeout }),
          nativeReadBudget: {
            readTimeoutMillis: 250,
            controlReadTimeoutMillis: 250,
          },
        },
      );
      try {
        monotonic = 50;
        checkout.resolve(client as unknown as PoolClient);
        expect(await pending).toBe('bounded');
        expect(
          query.mock.calls.find(([sql]) =>
            sql.includes("set_config('statement_timeout'"),
          )?.[1],
        ).toEqual(['200ms']);
        expect(release).toHaveBeenCalledExactlyOnceWith();
      } finally {
        checkout.resolve(client as unknown as PoolClient);
        await pending.catch(() => undefined);
        clock.mockRestore();
      }
    },
  );
});
