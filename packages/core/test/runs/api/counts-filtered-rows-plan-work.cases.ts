import { expect, it } from 'vitest';

import { explainWork } from '../../support/postgres/query-plan.js';

import {
  workspaceId,
  otherWorkspaceId,
  actorId,
  workflowId,
  otherWorkflowId,
  otherWorkflowVersionId,
  database,
  digest,
  startInput,
  ownerQuery,
  apiQueryWithIndexPreference,
} from './fixture.js';

export function registerCountsFilteredRowsPlanWork(): void {
  it('counts filtered rows as plan work even when a scan emits no rows', () => {
    expect(
      explainWork({
        'Node Type': 'Seq Scan',
        'Actual Rows': 0,
        'Actual Loops': 1,
        'Rows Removed by Filter': 10_000,
        'Shared Hit Blocks': 125,
      }),
    ).toEqual({
      outputRowInstances: 0,
      rejectedRowInstances: 10_000,
      summedNodeRowWork: 10_000,
      rootSharedBufferTouches: 125,
      nodeTypes: ['Seq Scan'],
    });
  });

  it('paginates sub-millisecond run history completely without duplicates or cross-workspace rows', async () => {
    const first = await database.start(
      startInput(digest('history-request-1'), digest('history-key-1')),
    );
    const second = await database.start(
      startInput(digest('history-request-2'), digest('history-key-2')),
    );
    const filtered = await database.start(
      startInput(digest('history-request-3'), digest('history-key-3')),
    );
    const other = await database.start(
      startInput(digest('history-request-other'), digest('history-key-other'), {
        workspaceId: otherWorkspaceId,
        workflowId: otherWorkflowId,
        workflowVersionId: otherWorkflowVersionId,
      }),
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = case id
         when $1 then '2026-08-21T12:00:00.000100Z'::timestamptz
         when $2 then '2026-08-21T12:00:00.000900Z'::timestamptz
       end,
       input_ref_expires_at = case id
         when $1 then '2026-09-20T12:00:00.000100Z'::timestamptz
         when $2 then '2026-09-20T12:00:00.000900Z'::timestamptz
       end,
       status = 'succeeded'
       where id in ($1, $2)`,
      [first.run.id, second.run.id],
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = '2026-08-21T12:00:00.001500Z'::timestamptz,
           input_ref_expires_at = '2026-09-20T12:00:00.001500Z'::timestamptz,
           status = 'failed'
       where id = $1`,
      [filtered.run.id],
    );
    await ownerQuery(
      `update app.workflow_runs
       set created_at = '2026-08-21T12:00:00.000950Z'::timestamptz,
           input_ref_expires_at = '2026-09-20T12:00:00.000950Z'::timestamptz
       where id = $1`,
      [other.run.id],
      otherWorkspaceId,
    );

    const seen: string[] = [];
    let after: Readonly<{ createdAt: string; id: string }> | undefined;
    do {
      const page = await database.list({
        actorId: actorId,
        workspaceId,
        workflowId,
        workflowNamePrefix: 'Executable Run',
        includeWorkflowName: true,
        limit: 1,
        createdAtFrom: '2026-08-21T12:00:00.000000Z',
        createdAtBefore: '2026-08-21T12:00:00.001000Z',
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map(({ id }) => id));
      after = page.nextCursor;
    } while (after !== undefined);

    expect(seen).toHaveLength(2);
    expect(new Set(seen)).toEqual(new Set([first.run.id, second.run.id]));
    expect(seen).not.toContain(other.run.id);
    const named = await database.list({
      actorId: actorId,
      workspaceId,
      workflowNamePrefix: 'Executable Run API',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(named.items.length).toBeGreaterThan(0);
    expect(
      named.items.every(
        ({ workflowName }) => workflowName === 'Executable Run API',
      ),
    ).toBe(true);
    await expect(
      database.list({
        actorId: actorId,
        workspaceId,
        workflowNamePrefix: 'Executable Run API%',
        includeWorkflowName: true,
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      database.list({
        actorId: actorId,
        workspaceId,
        workflowNamePrefix: 'Executable Run API\\',
        includeWorkflowName: true,
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
    await ownerQuery(
      `update app.workflows set name = 'Éxecutable Run API'
       where workspace_id = $1 and id = $2`,
      [workspaceId, workflowId],
    );
    const literalSpecials = await database.list({
      actorId: actorId,
      workspaceId,
      workflowNamePrefix: 'Éxecutable',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(literalSpecials.items.length).toBeGreaterThan(0);
    expect(
      literalSpecials.items.every(
        ({ workflowName }) => workflowName === 'Éxecutable Run API',
      ),
    ).toBe(true);
    await ownerQuery(
      `update app.workflows set lifecycle_status = 'archived'
       where workspace_id = $1 and id = $2`,
      [workspaceId, workflowId],
    );
    const archivedNamed = await database.list({
      actorId: actorId,
      workspaceId,
      workflowNamePrefix: 'Éxecutable',
      includeWorkflowName: true,
      limit: 10,
    });
    expect(
      archivedNamed.items.some(
        ({ workflowName }) => workflowName === 'Éxecutable Run API',
      ),
    ).toBe(true);
    await expect(
      database.list({
        actorId: actorId,
        workspaceId,
        workflowId,
        status: 'failed',
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [{ id: filtered.run.id }] });

    const indexes = await ownerQuery(
      `select indexname from pg_indexes
       where schemaname = 'app' and indexname in
         ('workflow_runs_workspace_created_idx',
          'workflow_runs_workspace_workflow_created_idx')
       order by indexname`,
    );
    expect(indexes.rows).toEqual([
      { indexname: 'workflow_runs_workspace_created_idx' },
      { indexname: 'workflow_runs_workspace_workflow_created_idx' },
    ]);
    const plan = await apiQueryWithIndexPreference(
      `explain (format json)
       select id from app.workflow_runs
       where workspace_id = $1 and workflow_id = $2
       order by created_at desc, id desc
       limit 50`,
      [workspaceId, workflowId],
    );
    expect(JSON.stringify(plan.rows)).toContain(
      'workflow_runs_workspace_workflow_created_idx',
    );
    const namePlan = await apiQueryWithIndexPreference(
      `explain (analyze, buffers, format json)
       select run.id
       from app.workflow_runs run
       join app.workflows workflow
         on workflow.workspace_id = run.workspace_id
        and workflow.id = run.workflow_id
       where run.workspace_id = $1
         and lower(workflow.name) like lower($2) || '%' escape '\\'
       order by run.created_at desc, run.id desc
       limit 50`,
      [workspaceId, 'Éxecutable'],
    );
    expect(JSON.stringify(namePlan.rows)).toContain(
      'workflow_runs_workspace_created_idx',
    );
  });
}
