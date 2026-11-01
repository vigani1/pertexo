import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { serializeStoredExecutionValue } from '@pertexo/database/primitives';
import {
  workspaceId,
  enforceTestRetention,
  purgeTestWorkspace,
} from '../../../support/workflow-authoring.js';
import {
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
} from './fixture.js';

export function registerKeepsSharedSourceFirstRun(): void {
  it('keeps a shared source when its first run expires and purges it after the last reference', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const initial = runId(first, 0);
    await complete(initial, { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const second = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const last = runId(second, 1);
    await complete(last, { amount: 2 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [last],
      )
    )[0]?.workflow_version_id;
    await query(
      "update app.workflow_runs set created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [initial],
    );
    await enforceTestRetention(2);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).not.toBeNull();
    expect(
      (await database.workflowTests.list(f.scope)).items.map(
        (entry) => entry.runId,
      ),
    ).toEqual([last]);
    await query(
      "update app.workflow_runs set created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [last],
    );
    await query(
      "update app.workflow_test_suites set created_at=clock_timestamp()-interval '9 days',deadline_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [accepted.suiteId],
    );
    await query(
      "update app.workflow_test_snapshots set expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [source],
    );
    await expect(
      database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    await enforceTestRetention(2);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).toBeNull();
  });

  it('checks one successful step invocation, missing paths, truncated actuals and repeated-step ambiguity', async () => {
    const f = await fixture(1);
    const record = f.records[0];
    if (record === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: record.caseId,
      expectedRevision: 1,
      name: 'Step checks',
      input: {},
      expectations: {
        outcome: 'succeeds',
        assertions: [
          {
            source: { kind: 'step', nodeId: 'set' },
            path: '$.amount',
            operator: 'equals',
            expected: 1,
          },
          {
            source: { kind: 'final' },
            path: '$.missing',
            operator: 'equals',
            expected: null,
          },
          {
            source: { kind: 'final' },
            path: '$.long',
            operator: 'contains',
            expected: 'thread',
          },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    const accepted = await database.workflowTestSuites.start(await command(f)),
      detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      }),
      id = runId(detail, 0);
    for (const invocation of ['first', 'second'])
      await query(
        "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,output_ref) values($1,$2,$3,'set',$4,'succeeded','safe',$5::jsonb)",
        [
          randomUUID(),
          workspaceId,
          id,
          invocation,
          serializeStoredExecutionValue({
            kind: 'inline',
            value: { amount: 1 },
          }),
        ],
      );
    await complete(id, { long: 'thread'.repeat(1500) });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 0,
        })
      ).report,
    ).toMatchObject({
      assertions: [
        { actual: { state: 'ambiguous', matched: false } },
        { actual: { state: 'missing', matched: false } },
        {
          actual: {
            state: 'value',
            matched: true,
            truncated: true,
            bytes: 9002,
          },
        },
      ],
    });
  });

  it('purges suites and their copied case values with the workspace', async () => {
    const steps = await purgeTestWorkspace(workspaceId, { pageSize: 50 });
    expect(steps).toContain('workflow_test_suites');
    expect(
      await query(
        'select suite_id from app.workflow_test_suite_cases where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
  }, 30000);
}
