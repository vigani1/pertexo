import { expect, it } from 'vitest';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { calls, pending, initial, outcome } from './fixture.js';

export function registerPassesErrorWorkflowOriginChild(): void {
  it('passes an error-workflow origin to its child so failure cannot start another error workflow', async () => {
    const f = await pending();
    await admin.query(
      'update app.workflow_runs set error_workflow_origin=true where id=$1',
      [f.parentRunId],
    );
    await calls.performActions(f.input, initial);
    const result = await outcome(f.parentRunId);
    if (result.child_run_id === null) throw new Error('Child was not accepted');
    const child = await admin.query<{
      error_workflow_origin: boolean;
      trigger_type: string;
    }>(
      'select error_workflow_origin,trigger_type from app.workflow_runs where id=$1',
      [result.child_run_id],
    );
    expect(child.rows[0]).toEqual({
      error_workflow_origin: true,
      trigger_type: 'workflow_call',
    });
  });
}
