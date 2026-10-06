import { describe, expect, it } from 'vitest';
import { toWorkflowRunReadRecord } from '../src/execution/runs/workflow-run-persistence-support.js';

const id = '00000000-0000-4000-8000-000000000101';
const row = {
  id,
  workspace_id: id,
  workflow_id: id,
  workflow_version_id: id,
  status: 'running',
  trigger_type: 'workflow_call',
  created_at: new Date(),
  updated_at: new Date(),
  started_at: null,
  completed_at: null,
  deadline_at: null,
  cancel_requested_at: null,
  workflow_name: 'Callable child',
  replay_source_run_id: null,
};
describe('native child existing run read projection', () => {
  it('preserves native provenance without fabricating replay lineage', () => {
    expect(toWorkflowRunReadRecord(row)).toMatchObject({
      triggerType: 'workflow_call',
      replaySourceRunId: null,
      workflowName: 'Callable child',
    });
  });
  it('still rejects unknown trigger provenance', () => {
    expect(() =>
      toWorkflowRunReadRecord({ ...row, trigger_type: 'unknown' }),
    ).toThrow();
  });
});
