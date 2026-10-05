import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { checkInlineWorkflowCallCoordinatorReadiness } from '../src/execution/coordinator/coordinator-native-readiness.js';

it.each([true, false])(
  'checks the registered catalog in a context-free read-only snapshot, compatible=%s',
  async (compatible) => {
    const statements: string[] = [];
    const release = vi.fn();
    const query = vi.fn((statement: string) => {
      statements.push(statement);
      if (statement.includes("current_setting('app.workspace_id'"))
        return Promise.resolve({
          rows: [{ workspace_id: null, actor_id: null, discovery_scope: null }],
        });
      if (statement.includes('pg_get_userbyid(runtime_role)'))
        return Promise.resolve({
          rows: [
            { api_role: 'pertexo_api', operator_role: 'pertexo_operator' },
          ],
        });
      if (statement.includes(' compatible'))
        return Promise.resolve({ rows: [{ compatible }] });
      return Promise.resolve({ rows: [] });
    });
    const client = Object.assign(new EventEmitter(), { query, release });
    const connect = vi.fn(
      (callback: (error: undefined, acquired: PoolClient) => void) => {
        callback(undefined, client as unknown as PoolClient);
      },
    );
    const pool = {
      connect,
      options: { connectionTimeoutMillis: 100 },
    } as unknown as Pool;
    const checked = checkInlineWorkflowCallCoordinatorReadiness(
      pool,
      'pertexo_owner',
      'pertexo_worker',
      2_000,
    );
    if (compatible) await expect(checked).resolves.toBeUndefined();
    else
      await expect(checked).rejects.toThrow(
        'Inline workflow Call registered catalog is incompatible',
      );
    expect(connect).toHaveBeenCalledOnce();
    expect(statements).toContain(
      'begin isolation level repeatable read read only',
    );
    expect(statements).toContain(compatible ? 'commit' : 'rollback');
    expect(statements).not.toContain(compatible ? 'rollback' : 'commit');
    expect(statements.some((text) => text.includes("set_config('app."))).toBe(
      false,
    );
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('end')).toBe(0);
  },
);
