import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { createWorkflowTestSuiteScanner } from '../../../../src/previews/suites/scanner.js';

import { workspaceId } from '../../../support/workflow-authoring.js';
import {
  config,
  maintenance,
  database,
  cases,
  scanner,
  reader,
  query,
  fixture,
  command,
  due,
  complete,
  runId,
  restartSuiteScanner,
} from './fixture.js';

export function registerFreezesCasesSharesOneSource(): void {
  it('freezes cases, shares one source and advances once across competing scanners and restarts', async () => {
    const f = await fixture(),
      intent = await command(f),
      accepted = await database.workflowTestSuites.start(intent);
    expect(await database.workflowTestSuites.start(intent)).toEqual(accepted);
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(first.cases.map((entry) => entry.status)).toEqual([
      'running',
      'pending',
    ]);
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [runId(first, 0)],
      )
    )[0]?.workflow_version_id;
    expect(source).toBeTruthy();
    expect(source).not.toBe(runId(first, 0));
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).toMatchObject({
      workflowId: f.scope.workflowId,
      test: { pinnedNodeIds: [] },
    });
    const second = f.records[1];
    if (second === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: second.caseId,
      expectedRevision: 1,
      name: 'Changed',
      input: { amount: 99 },
      idempotencyKey: randomUUID(),
    });
    expect(await database.workflowTestSuites.start(intent)).toEqual(accepted);
    await complete(runId(first, 0), { amount: 1 });
    await due(accepted.suiteId);
    const other = await createWorkflowTestSuiteScanner(config(), maintenance());
    try {
      await Promise.all([scanner.scan(25), other.scan(25)]);
    } finally {
      await other.close();
    }
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(next.cases.map((entry) => entry.status)).toEqual([
      'passed',
      'running',
    ]);
    expect(
      (
        await query<{ input_ref: unknown; workflow_version_id: string }>(
          'select input_ref,workflow_version_id from app.workflow_runs where id=$1',
          [runId(next, 1)],
        )
      )[0]?.workflow_version_id,
    ).toBe(source);
    expect(
      (
        await query<{ input: string }>(
          'select input from app.workflow_test_suite_cases where suite_id=$1 and ordinal=1',
          [accepted.suiteId],
        )
      )[0]?.input,
    ).toBe('{"amount":2}');
    await complete(runId(next, 1), { amount: 2 });
    await due(accepted.suiteId);
    await restartSuiteScanner();
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed', passed: 2, total: 2 });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 1,
        })
      ).report,
    ).toMatchObject({
      outcomeMatched: true,
      assertions: [{ actual: { state: 'value', value: 2, matched: true } }],
    });
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workflow_id=$1',
        [f.scope.workflowId],
      ),
    ).toHaveLength(1);
    expect(
      (await database.workflowTestSuites.list(f.scope)).current.signature,
    ).not.toBe(first.signature);
  });

  it('refuses stale cases and mutual standalone/suite overlap before any new run', async () => {
    const f = await fixture(1),
      intent = await command(f),
      entry = f.records[0];
    if (entry === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: entry.caseId,
      expectedRevision: 1,
      name: 'Edited',
      input: { amount: 1 },
      idempotencyKey: randomUUID(),
    });
    await expect(
      database.workflowTestSuites.start(intent),
    ).rejects.toMatchObject({ reason: 'cases_changed' });
    const accepted = await database.workflowTestSuites.start(await command(f));
    const p = await database.workflowTests.prepare(f.scope);
    await expect(
      database.workflowTests.start({
        ...f.scope,
        idempotencyKey: randomUUID(),
        request: {
          expectedRevision: p.draftRevision,
          expectedSamples: p.samples,
          expectedEffectfulSteps: [],
          acknowledgeSideEffects: false,
          input: {},
        },
      }),
    ).rejects.toMatchObject({ reason: 'already_running' });
    const detail = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await complete(runId(detail, 0), { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
  });

  it('admits fifty serial tests with one immutable snapshot and bounded history', async () => {
    const f = await fixture(50),
      accepted = await database.workflowTestSuites.start(await command(f));
    for (let ordinal = 0; ordinal < 50; ordinal++) {
      const detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      expect(
        detail.cases.filter((entry) => entry.status === 'running'),
      ).toHaveLength(1);
      await complete(runId(detail, ordinal), { amount: ordinal + 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed', passed: 50, total: 50 });
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workflow_id=$1',
        [f.scope.workflowId],
      ),
    ).toHaveLength(1);
  }, 30000);
}
