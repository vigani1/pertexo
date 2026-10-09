import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import {
  EMPTY_WORKFLOW_GRAPH_V1,
  InvalidWorkflowGraphError,
} from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  EMPTY_DEFINITION_CATALOG_V1,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import {
  admitWorkflowAuthoring,
  authoringIdleBudgetIsSafe,
} from '../src/authoring/workflow-authoring-admission.js';
import { createWorkflowAuthoringReadStore } from '../src/authoring/workflow-authoring-reads.js';
import { createWorkflowPublisher } from '../src/authoring/workflow-publication.js';
import { WorkflowRevisionConflictError } from '../src/authoring/workflow-authoring-errors.js';
import { IdempotencyConflictError } from '../src/platform/idempotency.js';
import { createWorkflowAuthoringDatabase } from '../src/authoring/workflow-authoring.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const graph = EMPTY_WORKFLOW_GRAPH_V1;
const catalog = EMPTY_DEFINITION_CATALOG_V1;
const row = {
  workspace_id: workspaceId,
  workflow_id: workflowId,
  revision: 7,
  schema_version: 1,
  graph_json: graph,
  updated_by: actorId,
  updated_at: new Date('2026-09-28T00:00:00Z'),
};
const tag = workflowDraftRepresentationTag({
  workflowId,
  revision: 7,
  graph,
  compatibilityFingerprint: workflowCompatibilityReport(graph, catalog)
    .fingerprint,
});
const command = {
  workspaceId,
  workflowId,
  actorId,
  representationTag: tag,
  idempotencyKey: 'original-key',
  requestHash: 'a'.repeat(64),
};
const valid = {
  ok: true as const,
  issues: [] as const,
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};
const invalid = {
  ok: false as const,
  issues: [
    {
      code: 'invalid_expression' as const,
      path: '$.nodes.action.inputMappings.value',
      message: 'The expression cannot be parsed.',
    },
  ],
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};
const budget = { rows: [{ setting: '35000', unit: 'ms' }] };

describe('effective authoring idle budget', () => {
  it.each([
    ['35000', 'ms', true],
    ['2251', 'ms', true],
    ['2250', 'ms', false],
    ['2', 's', false],
    ['3', 's', true],
    ['1', 'min', true],
    ['2250001', 'us', true],
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
      [{ setting: '2250', unit: 'ms' }],
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
      admitWorkflowAuthoring({ query }, validator, graph, controller.signal),
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
      admitWorkflowAuthoring({ query }, validator, graph, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(validator).toHaveBeenCalledOnce();
  });
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
    const database = createWorkflowAuthoringDatabase(config);
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
    const query = vi.fn((sql: string) => {
      if (sql === 'begin') transaction = true;
      if (sql === 'rollback') {
        rollbackEntered();
        return rollback.then(() => {
          transaction = false;
          return { rows: [] };
        });
      }
      if (sql.includes("current_setting('app.workspace_id'"))
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
      if (sql.includes('select 1 from app.workspace_memberships'))
        return Promise.resolve({ rows: [{}], rowCount: 1 });
      if (sql.includes('select * from app.workflow_drafts'))
        return Promise.resolve({ rows: [row] });
      if (sql.includes('pg_settings')) return Promise.resolve(budget);
      return Promise.resolve({ rows: [] });
    });
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
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce(budget);
    const client = { query } as unknown as PoolClient;
    const validator = vi.fn().mockResolvedValue(invalid);
    const selectValidationVariant = vi.fn().mockResolvedValue({
      definitionCatalog: catalog,
      validateAuthoringGraph: validator,
    });
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
      requireReader: vi.fn().mockResolvedValue(undefined),
      selectDefinitionCatalog: vi
        .fn()
        .mockRejectedValue(new Error('separate catalog read forbidden')),
      selectValidationVariant,
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
    expect(selectValidationVariant).toHaveBeenCalledOnce();
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
    const query = vi.fn((sql: string) => {
      if (sql.includes('select request_hash'))
        return Promise.resolve({
          rows: [
            {
              request_hash: requestHash,
              status,
              result_ref: { versionId: workflowId, reused: false },
            },
          ],
        });
      if (sql.includes('from app.workflow_versions'))
        return Promise.resolve({
          rows: [
            {
              id: workflowId,
              workspace_id: workspaceId,
              workflow_id: workflowId,
              version_number: 1,
              schema_version: 1,
              graph_json: graph,
              checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
              published_by: actorId,
              published_at: row.updated_at,
            },
          ],
        });
      if (sql.includes('select id from app.workflows'))
        return Promise.resolve({ rows: [{ id: workflowId }] });
      if (sql.includes('select * from app.workflow_drafts'))
        return Promise.resolve({ rows: [row] });
      if (sql.includes('pg_settings')) return Promise.resolve(budget);
      return Promise.resolve({ rows: [] });
    });
    const client = { query } as unknown as PoolClient;
    const validator = vi.fn().mockResolvedValue(invalid);
    const executableCompiler = vi.fn();
    const selectVariant = vi.fn().mockResolvedValue({
      definitionCatalog: catalog,
      compatibilityRelease: undefined,
      executableCompiler,
      validateAuthoringGraph: validator,
    });
    const replay = {
      reused: false,
      version: {
        id: workflowId,
        workspaceId,
        workflowId,
        versionNumber: 1,
        schemaVersion: 1,
        graphJson: graph,
        checksum: `wf:v2:sha256:${'a'.repeat(64)}` as const,
        publishedBy: actorId,
        publishedAt: row.updated_at,
      },
    };
    const requireAuthor = vi.fn().mockResolvedValue(undefined);
    const transact = vi.fn();
    const publish = createWorkflowPublisher({
      requireAuthor,
      selectVariant,
      testHooks: undefined,
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
      selectVariant,
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
    expect(fixture.selectVariant).not.toHaveBeenCalled();
    expect(fixture.validator).not.toHaveBeenCalled();
    expect(
      fixture.query.mock.calls.some(([sql]) => sql.includes('workflow_drafts')),
    ).toBe(false);
  });

  it('rejects changed exact-key bodies before reading or admitting the draft', async () => {
    const fixture = publisher('completed', 'b'.repeat(64));
    await expect(fixture.publish(command)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(fixture.selectVariant).not.toHaveBeenCalled();
  });

  it('checks the original ETag before admission and never compiles or writes an invalid expression', async () => {
    const fixture = publisher();
    await expect(
      fixture.publish({
        ...command,
        representationTag: `"draft-v1.${'a'.repeat(43)}"`,
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
        sql.includes('insert into app.workflow_versions'),
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
    expect(fixture.validator).toHaveBeenCalledWith(graph, { signal });
    expect(fixture.transact).toHaveBeenCalledWith(
      workspaceId,
      actorId,
      expect.any(Function),
      signal,
    );
    expect(fixture.executableCompiler).not.toHaveBeenCalled();
  });
});
