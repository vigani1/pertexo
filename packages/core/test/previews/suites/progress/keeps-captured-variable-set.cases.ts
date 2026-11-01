import { expect, it } from 'vitest';

import { createRetentionStore } from '../../../../src/lifecycle/retention/store.js';
import { setVariableSet } from '../../../support/variable-sets.js';
import { workspaceId } from '../../../support/workflow-authoring.js';
import { command, database, fixture, maintenance, query } from './fixture.js';

export function registerKeepsCapturedVariableSet(): void {
  it('keeps the set a running suite captured through retention, even after its case runs let go of it', async () => {
    await setVariableSet(workspaceId, { RATE: 10 });
    const f = await fixture(2);
    const { suiteId } = await database.workflowTestSuites.start(
      await command(f),
    );
    const [captured] = await query<{ revision: number }>(
      'select variable_set_revision as revision from app.workflow_test_suites where id=$1',
      [suiteId],
    );
    await setVariableSet(workspaceId, { RATE: 20 });
    // The suite is then the only thing holding the set: its next case still needs it.
    await query(
      'update app.workflow_runs set variable_set_revision=null where workspace_id=$1 and variable_set_revision=$2',
      [workspaceId, captured?.revision],
    );
    const retention = createRetentionStore(maintenance());
    try {
      await retention.enforce();
    } finally {
      await retention.close();
    }
    expect(
      await query(
        'select values_json from app.workspace_variable_set_revisions where workspace_id=$1 and revision=$2',
        [workspaceId, captured?.revision],
      ),
    ).toEqual([{ values_json: { RATE: 10 } }]);
  });
}
