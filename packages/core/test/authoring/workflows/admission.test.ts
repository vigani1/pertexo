import { draftWireRow } from '../../support/workflow-authoring/drafts.js';
import { describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import { createWorkflowAuthoringStore } from '../../../src/authoring/workflows/workflow-authoring.store.js';
import { testExecutableCompiler } from '../../../src/authoring/test-executable-compiler.js';
import {
  workspaceId,
  workflowId,
  actorId,
  graph,
  row,
  budget,
  valid,
} from './admission.fixture.js';
import { admitWorkflowAuthoring } from '../../../src/authoring/workflows/admission.repository.js';
import { authoringIdleBudgetIsSafe } from '../../../src/authoring/workflows/idle-budget.js';

describe('effective authoring idle budget', () => {
  it.each([
    ['35000', 'ms', true],
    ['6251', 'ms', true],
    ['6250', 'ms', false],
    ['6', 's', false],
    ['7', 's', true],
    ['1', 'min', true],
    ['6250001', 'us', true],
    ['0', 'ms', false],
    ['-1', 'ms', false],
    ['NaN', 'ms', false],
    ['2.5', 's', false],
    ['99999999999999999999', 'ms', false],
    ['35000', 'unknown', false],
    [undefined, 'ms', false],
    ['35000', null, false],
  ])('qualifies setting %s unit %s as %s', (setting, unit, expected) => {
    expect(authoringIdleBudgetIsSafe(setting, unit)).toBe(expected);
  });

  it('fails closed before dispatch without wiring, with unknown/unlimited or too-small effective settings', async () => {
    const validator = vi.fn().mockResolvedValue(valid);
    const query = vi.fn().mockResolvedValue(budget);
    await expect(
      admitWorkflowAuthoring({ query }, undefined, graph),
    ).rejects.toMatchObject({ reason: 'not_configured' });
    expect(query).not.toHaveBeenCalled();
    for (const rows of [
      [],
      [{ setting: '0', unit: 'ms' }],
      [{ setting: '6250', unit: 'ms' }],
    ]) {
      query.mockResolvedValue({ rows });
      await expect(
        admitWorkflowAuthoring({ query }, validator, graph),
      ).rejects.toMatchObject({ reason: 'database_budget' });
    }
    expect(validator).not.toHaveBeenCalled();
  });

  it('rechecks the actual connection each admission and forwards cancellation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(budget)
      .mockResolvedValueOnce({ rows: [{ setting: '1000', unit: 'ms' }] });
    const validator = vi.fn().mockResolvedValue(valid);
    const controller = new AbortController();
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph, {
        signal: controller.signal,
      }),
    ).resolves.toBe(valid);
    expect(validator).toHaveBeenCalledWith(graph, {
      signal: controller.signal,
    });
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph),
    ).rejects.toMatchObject({ reason: 'database_budget' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(validator).toHaveBeenCalledOnce();
    query.mockResolvedValue(budget);
    controller.abort();
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(validator).toHaveBeenCalledOnce();
  });
});
describe('authoring cancellation and runtime lifetime', () => {
  it('forwards pre-checkout cancellation through the real authoring wrapper', async () => {
    const config = {
      connectionString: 'postgresql://invalid.invalid/pertexo',
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
      max: 1,
      ownerRole: 'pertexo_owner',
    } as const;
    const database = createWorkflowAuthoringStore(config, {
      executableCompiler: testExecutableCompiler,
    });
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockRejectedValue(new Error('must not check out'));
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        database.validateDraft(workspaceId, workflowId, actorId, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await database.close();
    }
  });

  it('waits for authoring rollback/context release before closing a shared runtime lease', async () => {
    const config = {
      connectionString: 'postgresql://invalid.invalid/pertexo',
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
      max: 1,
      ownerRole: 'pertexo_owner',
    } as const;
    let finishRollback: () => void = () => {
      throw new Error('rollback not initialized');
    };
    let rollbackEntered: () => void = () => {
      throw new Error('rollback not initialized');
    };
    const rollback = new Promise<void>((resolve) => {
      finishRollback = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      rollbackEntered = resolve;
    });
    const release = vi.fn();
    const query = vi.fn(
      (statement: string | { text: string; rowMode?: 'array' }) => {
        const sql = (
          typeof statement === 'string' ? statement : statement.text
        ).replaceAll('"', '');
        if (sql === 'rollback') {
          rollbackEntered();
          return rollback.then(() => ({ rows: [] }));
        }
        if (
          typeof statement !== 'string' &&
          statement.rowMode === 'array' &&
          /from app\.(workspaces|users|workspace_memberships|workflow_folders|workflows)\b/u.test(
            sql,
          )
        ) {
          const rows = sql.includes('workflow_folders')
            ? []
            : [sql.includes('workspace_memberships') ? ['owner'] : [1]];
          return Promise.resolve({ rows, rowCount: rows.length });
        }
        // PostgreSQL returns each value the context statement sets.
        if (sql.startsWith('select set_config('))
          return Promise.resolve({
            rows: [
              {
                workspaceId,
                actorId,
                discoveryScope: '',
                statementTimeoutMillis: '30000',
              },
            ],
          });
        if (
          sql.startsWith('select 1 from app.workspaces') ||
          sql.startsWith('select 1 from app.users') ||
          sql.startsWith('select 1 from app.workflows workflow')
        )
          return Promise.resolve({ rows: [{}], rowCount: 1 });
        if (sql.startsWith('select role from app.workspace_memberships'))
          return Promise.resolve({ rows: [{ role: 'owner' }], rowCount: 1 });
        if (sql.includes('from app.workflow_drafts'))
          return Promise.resolve({ rows: [draftWireRow(row)] });
        if (sql.includes('pg_settings')) return Promise.resolve(budget);
        return Promise.resolve({ rows: [] });
      },
    );
    // This test exercises the promise-only checkout used by tenant transactions,
    // not pg's separate callback overload.
    const checkout = Pool.prototype as unknown as {
      connect(): Promise<PoolClient>;
    };
    const connect = vi
      .spyOn(checkout, 'connect')
      .mockResolvedValue({ query, release } as unknown as PoolClient);
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const database = createWorkflowAuthoringStore(config, {
      executableCompiler: testExecutableCompiler,
      runtime,
      validateAuthoringGraph: () =>
        Promise.reject(
          new AuthoringValidationUnavailableError('termination_failed'),
        ),
    });
    try {
      const validation = database.validateDraft(
        workspaceId,
        workflowId,
        actorId,
      );
      const failure = expect(validation).rejects.toMatchObject({
        reason: 'termination_failed',
      });
      await entered;
      let closed = false;
      const close = database.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(release).not.toHaveBeenCalled();
      finishRollback();
      await failure;
      await close;
      expect(closed).toBe(true);
      expect(release).toHaveBeenCalledOnce();
      expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(false);
    } finally {
      finishRollback();
      await database.close();
      await runtime.close();
      connect.mockRestore();
    }
  });
});
