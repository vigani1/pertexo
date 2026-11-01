import { expect, it } from 'vitest';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { delivery, fixture, store } from './fixture.js';

export function registerCapturesCurrentVariables(): void {
  it('starts the error workflow on the set current at its own admission, not its source set', async () => {
    const f = await fixture();
    await admin.query(
      `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
       values($1,1,'{"RATE":10}'),($1,2,'{"RATE":20}')`,
      [f.workspaceId],
    );
    await admin.query(
      'insert into app.workspace_variables(workspace_id,revision) values($1,2)',
      [f.workspaceId],
    );
    await admin.query(
      'update app.workflow_runs set variable_set_revision=1 where id=$1',
      [f.parentRunId],
    );
    await f.produce();
    await store.dispatch(await delivery(f));
    const runs = await admin.query<{ revision: number }>(
      "select variable_set_revision as revision from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
      [f.workspaceId],
    );
    expect(runs.rows).toEqual([{ revision: 2 }]);
    const source = await admin.query<{ revision: number }>(
      'select variable_set_revision as revision from app.workflow_runs where id=$1',
      [f.parentRunId],
    );
    expect(source.rows).toEqual([{ revision: 1 }]);
  });
}
