import { randomUUID } from 'node:crypto';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { snapshotTableCases } from '../../../src/previews/suites/evaluation/snapshot-table-cases.js';
import { expect, it } from 'vitest';
import { WORKFLOW_TEST_SUITE_MAX_CASES } from '@pertexo/workflow-model';
import { createDataTablesStore } from '../../../src/data-tables/index.js';
import {
  apiPool,
  enforceTestRetention,
  otherActorId,
  otherWorkspaceId,
} from '../../support/workflow-authoring.js';
import {
  command,
  complete,
  config,
  database,
  due,
  fixture,
  query,
  runId,
  scanner,
} from './progress.fixture.js';

export function registerTableEvaluationCases() {
  it('keeps the latest failed saved-case suite visible behind a full page of evaluations', async () => {
    const f = await fixture(1);
    const tables = createDataTablesStore(config());
    try {
      const saved = await database.workflowTestSuites.start(await command(f));
      const detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...saved,
      });
      await complete(runId(detail, 0), { amount: 0 });
      await due(saved.suiteId);
      await scanner.scan(25);

      const { evaluation } = await evaluationTable(tables, f, 1);
      for (let index = 0; index < 20; index++) {
        const { expectedCases: _saved, ...metadata } = (await command(f))
          .request;
        const accepted = await database.workflowTestSuites.start({
          ...f.scope,
          idempotencyKey: randomUUID(),
          request: { ...metadata, evaluation },
        });
        const detail = await database.workflowTestSuites.get({
          ...f.scope,
          ...accepted,
        });
        await complete(runId(detail, 0), { amount: 1 });
        await due(accepted.suiteId);
        await scanner.scan(25);
      }
      const list = await database.workflowTestSuites.list(f.scope);
      expect(list.items).toHaveLength(20);
      expect(
        list.items.every(
          (item) => item.evaluation?.tableId === evaluation.tableId,
        ),
      ).toBe(true);
      expect(list.latestSavedCaseSuite).toMatchObject({
        suiteId: saved.suiteId,
        signature: list.current.signature,
        status: 'failed',
      });
    } finally {
      await tables.close();
    }
  });

  it('resolves table cases into typed inputs and expectations for suite admission', async () => {
    const f = await fixture(0);
    const tables = createDataTablesStore(config());
    try {
      const { evaluation } = await evaluationTable(tables, f, 1);
      const cases = await withTenantScopedClient(apiPool, f.scope, (client) =>
        snapshotTableCases(client, 'owner', f.scope.workspaceId, evaluation),
      );
      expect(cases).toMatchObject([
        {
          input: { amount: 1 },
          expectations: {
            outcome: 'succeeds',
            assertions: [
              {
                source: { kind: 'final' },
                path: '$.amount',
                operator: 'equals',
                expected: 1,
              },
            ],
          },
        },
      ]);
    } finally {
      await tables.close();
    }
  });

  it('freezes version, table inputs and expectations and scores only completed cases', async () => {
    const f = await fixture(0);
    const tables = createDataTablesStore(config());
    try {
      const { table, evaluation } = await evaluationTable(tables, f, 4);
      const { expectedCases: _saved, ...metadata } = (await command(f)).request;
      const accepted = await database.workflowTestSuites.start({
        ...f.scope,
        idempotencyKey: randomUUID(),
        request: { ...metadata, evaluation },
      });
      const scope = { ...f.scope, ...accepted };
      const frozen = await query<{ input: string }>(
        'select input from app.workflow_test_suite_cases where suite_id=$1 order by ordinal',
        [accepted.suiteId],
      );
      await tables.write({
        ...f.scope,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'update',
          table: table.name,
          values: { amount: 90, expected: 90 },
          query: {
            limit: 4,
            offset: 0,
            filters: [{ column: 'amount', operator: 'greater_than', value: 0 }],
          },
        },
      });
      expect(
        JSON.parse(
          (
            await query<{ expectations: string }>(
              'select expectations from app.workflow_test_suite_cases where suite_id=$1 order by ordinal',
              [accepted.suiteId],
            )
          )[0]?.expectations ?? '',
        ),
      ).toEqual({
        outcome: 'succeeds',
        assertions: [
          {
            source: { kind: 'final' },
            path: '$.amount',
            operator: 'equals',
            expected: (JSON.parse(frozen[0]?.input ?? '') as { amount: number })
              .amount,
          },
        ],
      });
      const first = await database.workflowTestSuites.get(scope);
      expect(first.evaluation).toEqual({
        tableId: table.id,
        versionId: f.versionId,
      });
      expect(
        await database.workflowTests.get({
          ...f.scope,
          runId: runId(first, 0),
        }),
      ).toMatchObject({
        publishedVersionNumber: 1,
      });
      const firstInput = frozen[0]?.input ?? '';
      await complete(runId(first, 0), JSON.parse(firstInput));
      await due(accepted.suiteId);
      await scanner.scan(25);
      const second = await database.workflowTestSuites.get(scope);
      const [stored] = await query<{
        input_ref: { value: unknown };
      }>('select input_ref from app.workflow_runs where id=$1', [
        runId(second, 1),
      ]);
      expect(stored?.input_ref.value).toEqual(
        JSON.parse(frozen[1]?.input ?? ''),
      );
      await complete(runId(second, 1), { amount: 90 }, 'failed');
      await due(accepted.suiteId);
      await scanner.scan(25);
      const third = await database.workflowTestSuites.get(scope);
      const infrastructureRun = runId(third, 2);
      await complete(infrastructureRun, { amount: 90 }, 'failed');
      await query(
        "update app.workflow_runs set error_summary='execution.run_state_invalid' where id=$1",
        [infrastructureRun],
      );
      await due(accepted.suiteId);
      await scanner.scan(25);
      const fourth = await database.workflowTestSuites.get(scope);
      await complete(runId(fourth, 3), { amount: 90 }, 'canceled');
      await due(accepted.suiteId);
      await scanner.scan(25);
      const done = await database.workflowTestSuites.get(scope);
      expect(done).toMatchObject({
        total: 4,
        passed: 1,
        failed: 1,
        errors: 2,
        score: { matched: 1, total: 2, failedRuns: 1, incompleteCases: 2 },
      });
      expect(done.cases.map(({ status }) => status)).toEqual([
        'passed',
        'failed',
        'error',
        'error',
      ]);
    } finally {
      await tables.close();
    }
  });

  it('refuses over-cap and foreign tables before admitting a case', async () => {
    const f = await fixture(0);
    const tables = createDataTablesStore(config());
    try {
      const { table, evaluation } = await evaluationTable(
        tables,
        f,
        WORKFLOW_TEST_SUITE_MAX_CASES + 1,
      );
      const { expectedCases: _saved, ...metadata } = (await command(f)).request;
      const start = (tableId: string) =>
        database.workflowTestSuites.start({
          ...f.scope,
          idempotencyKey: randomUUID(),
          request: { ...metadata, evaluation: { ...evaluation, tableId } },
        });
      await expect(start(table.id)).rejects.toMatchObject({
        reason: 'evaluation_case_limit',
      });
      const foreign = await tables.create({
        ...f.scope,
        actorId: otherActorId,
        workspaceId: otherWorkspaceId,
        idempotencyKey: randomUUID(),
        name: `Foreign_${randomUUID().replaceAll('-', '')}`,
        columns: [{ name: 'amount', type: 'number', required: true }],
      });
      await expect(start(foreign.id)).rejects.toMatchObject({
        code: 'not_found',
      });
      expect((await database.workflowTests.list(f.scope)).items).toEqual([]);
    } finally {
      await tables.close();
    }
  });

  it('refuses effectful and unpinned Call steps before admitting any case', async () => {
    const target = await fixture(0);
    const [version] = await query<{ checksum: string }>(
      'select checksum from app.workflow_versions where id=$1',
      [target.versionId],
    );
    if (version === undefined) throw new Error('Missing Call target');
    const call = await fixture(0, 'core.call', {
      target: {
        workflowId: target.scope.workflowId,
        workflowVersionId: target.versionId,
        executableChecksum: version.checksum,
      },
    });
    const tables = createDataTablesStore(config());
    try {
      const { table, evaluation } = await evaluationTable(tables, call, 1);
      const unsafe = await fixture(0, 'core.table_insert', {
        table: table.name,
      });
      const start = async (f: typeof call) => {
        const { expectedCases: _saved, ...metadata } = (await command(f))
          .request;
        return database.workflowTestSuites.start({
          ...f.scope,
          idempotencyKey: randomUUID(),
          request: {
            ...metadata,
            evaluation: { ...evaluation, versionId: f.versionId },
          },
        });
      };
      await expect(start(unsafe)).rejects.toMatchObject({
        reason: 'evaluation_effectful',
      });
      await expect(start(call)).rejects.toMatchObject({
        reason: 'evaluation_pin_required',
      });
      expect((await database.workflowTests.list(unsafe.scope)).items).toEqual(
        [],
      );
      expect((await database.workflowTests.list(call.scope)).items).toEqual([]);
      await database.stepSamples.put({
        ...call.scope,
        nodeId: 'set',
        expectedDraftRevision: 1,
        expectedSampleId: null,
        idempotencyKey: randomUUID(),
        source: { kind: 'json', value: { amount: 1 } },
      });
      const accepted = await start(call);
      const result = await database.workflowTestSuites.get({
        ...call.scope,
        ...accepted,
      });
      const [source] = await query<{
        dispositions: Record<string, string>;
        pins: Record<string, { outputRef: string }>;
      }>(
        'select dispositions,pins from app.workflow_test_snapshots where id=(select snapshot_id from app.workflow_test_suites where id=$1)',
        [accepted.suiteId],
      );
      expect(source?.dispositions.set).toBe('pinned');
      expect(JSON.parse(source?.pins.set?.outputRef ?? '')).toEqual({
        kind: 'inline',
        value: { amount: 1 },
      });
      expect((await database.workflowTests.list(target.scope)).items).toEqual(
        [],
      );
      await complete(runId(result, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
      expect(
        await database.workflowTestSuites.get({ ...call.scope, ...accepted }),
      ).toMatchObject({
        status: 'passed',
        score: { matched: 1, total: 1 },
      });
    } finally {
      await tables.close();
    }
  });

  it('purges a completed evaluation with its retained case inputs', async () => {
    const f = await fixture(0);
    const tables = createDataTablesStore(config());
    try {
      const { evaluation } = await evaluationTable(tables, f, 1);
      const { expectedCases: _saved, ...metadata } = (await command(f)).request;
      const accepted = await database.workflowTestSuites.start({
        ...f.scope,
        idempotencyKey: randomUUID(),
        request: { ...metadata, evaluation },
      });
      const scope = { ...f.scope, ...accepted };
      await complete(runId(await database.workflowTestSuites.get(scope), 0), {
        amount: 1,
      });
      await due(accepted.suiteId);
      await scanner.scan(25);
      await query(
        "update app.workflow_test_suites set created_at=clock_timestamp()-interval '9 days',deadline_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
        [accepted.suiteId],
      );
      await expect(
        database.workflowTestSuites.get(scope),
      ).rejects.toMatchObject({ reason: 'not_found' });
      await enforceTestRetention(2);
      expect(
        await query(
          'select ordinal from app.workflow_test_suite_cases where suite_id=$1',
          [accepted.suiteId],
        ),
      ).toEqual([]);
    } finally {
      await tables.close();
    }
  });
}

async function evaluationTable(
  tables: ReturnType<typeof createDataTablesStore>,
  f: Awaited<ReturnType<typeof fixture>>,
  rows: number,
) {
  const created = await tables.create({
    ...f.scope,
    idempotencyKey: randomUUID(),
    name: `Evaluation_${randomUUID().replaceAll('-', '')}`,
    columns: [
      { name: 'amount', type: 'number', required: true },
      { name: 'expected', type: 'number', required: true },
    ],
  });
  const table = (await tables.list(f.scope)).tables.find(
    ({ id }) => id === created.id,
  );
  if (table === undefined) throw new Error('Missing evaluation table');
  await tables.importRows({
    ...f.scope,
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: rows }, (_, index) => ({
      amount: index + 1,
      expected: index + 1,
    })),
  });
  const [amount, expected] = table.columns;
  if (amount === undefined || expected === undefined)
    throw new Error('Missing columns');
  return {
    table,
    evaluation: {
      tableId: table.id,
      versionId: f.versionId,
      columns: { amount: amount.id },
      expectations: {
        outcome: 'succeeds' as const,
        assertions: [
          {
            source: { kind: 'final' as const },
            path: '$.amount',
            operator: 'equals' as const,
            expected: { kind: 'column' as const, columnId: expected.id },
          },
        ],
      },
    },
  };
}
