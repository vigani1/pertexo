import { draftWireRow } from '../../support/workflow-authoring/drafts.js';
import { folderScope } from '../../../src/tenant-access/resources/policy.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';

import { createWorkflowAuthoringReadStore } from '../../../src/authoring/workflows/reads.queries.js';
import { createWorkflowPublisher } from '../../../src/authoring/publication/publisher.repository.js';
import { WorkflowRevisionConflictError } from '../../../src/authoring/workflows/errors.js';
import {
  IdempotencyConflictError,
  createDatabaseRuntime,
} from '@pertexo/database/platform';
import { createWorkflowAuthoringDatabase } from '../../../src/authoring/workflows/repository.js';
import { testExecutableCompiler } from '../../../src/authoring/test-executable-compiler.js';
import {
  workspaceId,
  workflowId,
  actorId,
  graph,
  catalog,
  row,
  command,
  invalid,
  budget,
} from './admission/fixture.js';
import { registerIdleTimeoutSettings } from './admission/idle-timeout-setting.cases.js';
describe('effective authoring idle budget', () => {
  registerIdleTimeoutSettings();
});
describe('snapshot validation and publication ordering', () => {
  it('forwards pre-checkout cancellation through the real authoring wrapper', async () => {
    const config = {
      connectionString: 'postgresql://invalid.invalid/pertexo',
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
      max: 1,
      ownerRole: 'pertexo_owner',
    } as const;
    const database = createWorkflowAuthoringDatabase(config, {
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
    let transaction = false;
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
        if (sql === 'begin') transaction = true;
        if (sql === 'rollback') {
          rollbackEntered();
          return rollback.then(() => {
            transaction = false;
            return { rows: [] };
          });
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
        if (sql.startsWith("select current_setting('app.workspace_id'"))
          return Promise.resolve({
            rows: [
              {
                workspace_id: transaction ? workspaceId : null,
                actor_id: transaction ? actorId : null,
                discovery_scope: null,
                statement_timeout_millis: 30000,
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
    const database = createWorkflowAuthoringDatabase(config, {
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
  it('validates and returns one selected-release snapshot in one transaction, with its signal', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: workflowId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [draftWireRow(row)] })
      .mockResolvedValueOnce(budget)
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;
    const validator = vi.fn().mockResolvedValue(invalid);
    const transactions = vi.fn();
    async function transact<T>(
      workspaceId: string,
      actorId: string,
      operation: (client: PoolClient) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      transactions(workspaceId, actorId, operation, signal);
      signal?.throwIfAborted();
      return operation(client);
    }
    const store = createWorkflowAuthoringReadStore({
      requireReader: vi
        .fn()
        .mockResolvedValue(folderScope(workspaceId, 'owner', [], [])),
      catalogs: {
        definitionCatalog: catalog,
        executableCompiler: testExecutableCompiler,
        validateAuthoringGraph: validator,
      },
      transact,
    });
    const controller = new AbortController();
    const result = await store.validateDraft(workspaceId, workflowId, actorId, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      draft: { revision: 7, graphJson: graph },
      validation: invalid,
    });
    expect(transactions).toHaveBeenCalledWith(
      workspaceId,
      actorId,
      expect.any(Function),
      controller.signal,
    );
    expect(validator).toHaveBeenCalledWith(graph, {
      signal: controller.signal,
    });
  });

  function publisher(
    status = 'in_progress',
    requestHash = createHash('sha256')
      .update(JSON.stringify(command.requestHash))
      .digest('hex'),
  ) {
    const query = vi.fn(
      (statement: string | { text: string; rowMode?: 'array' }) => {
        const sql = (
          typeof statement === 'string' ? statement : statement.text
        ).replaceAll('"', '');
        // A new command inserts its claim; a retry finds it completed.
        if (sql.includes('insert into app.idempotency_records'))
          return Promise.resolve({
            rows: status === 'completed' ? [] : [[workflowId]],
            rowCount: status === 'completed' ? 0 : 1,
          });
        if (sql.includes('from app.idempotency_records'))
          return Promise.resolve({
            rows: [
              [requestHash, status, { versionId: workflowId, reused: false }],
            ],
          });
        if (sql.includes('from app.workflow_versions'))
          return Promise.resolve({
            rows: [
              [
                workflowId,
                workspaceId,
                workflowId,
                1,
                graph,
                `wf:sha256:${'a'.repeat(64)}`,
                actorId,
                row.updated_at,
              ],
            ],
          });
        if (sql.includes('from app.workflows'))
          return Promise.resolve({ rows: [[workflowId]] });
        if (sql.includes('from app.workflow_drafts'))
          return Promise.resolve({ rows: [draftWireRow(row)] });
        if (sql.includes('pg_settings')) return Promise.resolve(budget);
        return Promise.resolve({ rows: [] });
      },
    );
    const client = { query } as unknown as PoolClient;
    const validator = vi.fn().mockResolvedValue(invalid);
    const executableCompiler = vi.fn();
    const replay = {
      reused: false,
      version: {
        id: workflowId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        graphJson: graph,
        checksum: `wf:sha256:${'a'.repeat(64)}` as const,
        publishedBy: actorId,
        publishedAt: row.updated_at,
      },
    };
    const requireAuthor = vi.fn().mockResolvedValue(undefined);
    const transact = vi.fn();
    const publish = createWorkflowPublisher({
      requireAuthor,
      catalogs: {
        definitionCatalog: catalog,
        executableCompiler,
        placementDefinitionCatalog: undefined,
        workflowTestCompiler: undefined,
        portableCatalog: undefined,
        validateAuthoringGraph: validator,
      },
      transact: <T>(
        workspaceId: string,
        actorId: string,
        operation: (client: PoolClient) => Promise<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        transact(workspaceId, actorId, operation, signal);
        return operation(client);
      },
    });
    return {
      publish,
      query,
      validator,
      executableCompiler,
      requireAuthor,
      transact,
      replay,
    };
  }

  it('returns exact completed receipts without selecting policies, reading current draft or parsing', async () => {
    const fixture = publisher('completed');
    fixture.validator.mockRejectedValue(
      new AuthoringValidationUnavailableError('closed'),
    );
    await expect(fixture.publish(command)).resolves.toEqual({
      ...fixture.replay,
      replayed: true,
    });
    expect(fixture.requireAuthor).toHaveBeenCalledOnce();
    expect(fixture.validator).not.toHaveBeenCalled();
    expect(
      fixture.query.mock.calls.some(([sql]) =>
        (typeof sql === 'string' ? sql : sql.text).includes('workflow_drafts'),
      ),
    ).toBe(false);
  });

  it('rejects changed exact-key bodies before reading or admitting the draft', async () => {
    const fixture = publisher('completed', 'b'.repeat(64));
    await expect(fixture.publish(command)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('checks the original ETag before admission and never compiles or writes an invalid expression', async () => {
    const fixture = publisher();
    await expect(
      fixture.publish({
        ...command,
        representationTag: `"draft.${'a'.repeat(43)}"`,
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
    expect(fixture.validator).not.toHaveBeenCalled();
    await expect(fixture.publish(command)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
    expect(fixture.validator).toHaveBeenCalledOnce();
    expect(fixture.executableCompiler).not.toHaveBeenCalled();
    expect(
      fixture.query.mock.calls.some(([sql]) =>
        (typeof sql === 'string' ? sql : sql.text).includes(
          'insert into app.workflow_versions',
        ),
      ),
    ).toBe(false);
  });

  it('propagates unavailable admission and the transaction signal without creating a version', async () => {
    const fixture = publisher();
    const signal = new AbortController().signal;
    fixture.validator.mockRejectedValue(
      new AuthoringValidationUnavailableError('overloaded'),
    );
    await expect(fixture.publish({ ...command, signal })).rejects.toMatchObject(
      { reason: 'overloaded' },
    );
    expect(fixture.validator).toHaveBeenCalledWith(graph, {
      signal,
      workspaceVariableNames: [],
    });
    expect(fixture.transact).toHaveBeenCalledWith(
      workspaceId,
      actorId,
      expect.any(Function),
      signal,
    );
    expect(fixture.executableCompiler).not.toHaveBeenCalled();
  });
});
