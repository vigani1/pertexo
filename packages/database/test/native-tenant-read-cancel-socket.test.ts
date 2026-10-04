import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

// The PostgreSQL constructor is the external transport seam. Tenant lifecycle
// and cancellation/disposal implementations remain real; no database is contacted.
const transport = vi.hoisted(() => ({ connections: [] as EventEmitter[] }));
vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    Client: class {
      public readonly connection = Object.assign(new Emitter(), {
        connect: vi.fn(() => {
          this.connection.emit('connect');
        }),
        cancel: vi.fn(),
        stream: {
          destroy: vi.fn(() => {
            this.connection.emit('end');
          }),
        },
      });
      public constructor() {
        transport.connections.push(this.connection);
      }
      public end(): Promise<void> {
        this.connection.emit('end');
        return Promise.resolve();
      }
    },
  };
});

import { withTenantScopedReadClient } from '../src/tenant-access/workspace.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

describe('native tenant read cancellation transport ownership', () => {
  it.each(['end', 'error', 'timeout'] as const)(
    'joins the CancelRequest socket and removes its timer/listeners before returning the stop (%s)',
    async (terminal) => {
      vi.useFakeTimers();
      transport.connections.length = 0;
      const controller = new AbortController();
      const queryFinished = Promise.withResolvers<{ rows: never[] }>();
      const client = new EventEmitter();
      const release = vi.fn();
      const destroy = vi.fn();
      let scoped = false;
      let statementTimeout = 0;
      const query = vi.fn((sql: string, values?: readonly unknown[]) => {
        if (sql.includes("set_config('statement_timeout'"))
          statementTimeout = Number.parseInt(String(values?.[0]), 10);
        if (sql === 'select protected_native_source')
          return queryFinished.promise;
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
        processID: 123,
        secretKey: 456,
        host: '127.0.0.1',
        port: 5432,
        _getActiveQuery: () => ({}),
        connection: { stream: { destroy } },
      });
      const pool = {
        options: { connectionTimeoutMillis: 100 },
        connect: (
          callback: (error: Error | undefined, connection: PoolClient) => void,
        ) => {
          callback(undefined, client as unknown as PoolClient);
        },
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
        expect(transport.connections).toHaveLength(1);
        const cancellation = transport.connections[0];
        if (cancellation === undefined)
          throw new Error('Expected owned cancellation socket');
        queryFinished.resolve({ rows: [] });
        client.emit('end');
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        const wireFailure = new Error('CancelRequest transport failed');
        if (terminal === 'error') cancellation.emit('error', wireFailure);
        else if (terminal === 'timeout')
          await vi.advanceTimersByTimeAsync(1_000);
        else cancellation.emit('end');
        const result: unknown = await pending;
        if (terminal !== 'error')
          expect(result).toMatchObject({ name: 'AbortError' });
        else {
          expect(result).toBeInstanceOf(AggregateError);
          if (!(result instanceof AggregateError))
            throw new Error('Expected cleanup failure');
          const disposal: unknown = result.errors[1];
          expect(disposal).toBeInstanceOf(AggregateError);
          if (!(disposal instanceof AggregateError))
            throw new Error('Expected disposal failure');
          expect(disposal.errors).toEqual([wireFailure]);
        }
        expect(cancellation.listenerCount('error')).toBe(0);
        expect(cancellation.listenerCount('connect')).toBe(0);
        expect(cancellation.listenerCount('end')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(release).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
      } finally {
        controller.abort();
        queryFinished.resolve({ rows: [] });
        client.emit('end');
        for (const connection of transport.connections) connection.emit('end');
        await pending;
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );
});
