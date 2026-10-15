import type { Pool } from 'pg';
import { expect } from 'vitest';
import { workflowErrorInputSchema } from '@pertexo/workflow-model';

export async function verifyErrorWorkflowEvidence(database: Pool) {
  const rows = await database.query<{
    context: unknown;
    status: string;
    source_status: string;
    target_status: string;
    trigger_type: string;
    error_workflow_origin: boolean;
  }>(
    `select intent.context,intent.status,source.status source_status,target.status target_status,target.trigger_type,target.error_workflow_origin from app.run_error_workflow_intents intent join app.workflow_runs source on source.workspace_id=intent.workspace_id and source.id=intent.source_run_id join app.workflow_runs target on target.workspace_id=intent.workspace_id and target.id=intent.accepted_run_id limit 2`,
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toMatchObject({
    status: 'accepted',
    source_status: 'failed',
    target_status: 'succeeded',
    trigger_type: 'workflow_error',
    error_workflow_origin: true,
  });
  const summary = workflowErrorInputSchema.parse(rows.rows[0]?.context);
  expect(summary.failedStep?.id).toBe('summarize');
  expect(JSON.stringify(summary)).not.toMatch(
    /sensitive-password|not-a-number/u,
  );
}
