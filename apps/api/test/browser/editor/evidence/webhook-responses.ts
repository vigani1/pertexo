import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifyWebhookResponseEvidence(database: Pool) {
  const responses = await database.query(
    `select response.status_code,response.content_type,response.body,response.headers,run.trigger_type from app.webhook_run_responses response join app.workflow_runs run on run.id=response.run_id join app.workflows workflow on workflow.id=run.workflow_id where workflow.name='Webhook response qualification'`,
  );
  expect(responses.rows).toEqual([
    {
      status_code: 201,
      content_type: 'application/json',
      body: '{"accepted":true}',
      headers: { 'x-correlation-id': 'workflow-reply' },
      trigger_type: 'webhook',
    },
  ]);
  const steps = await database.query<{
    trigger_type: string;
    output_ref: unknown;
  }>(
    `select run.trigger_type,node.output_ref from app.node_runs node join app.workflow_runs run on run.id=node.workflow_run_id join app.workflows workflow on workflow.id=run.workflow_id where workflow.name='Webhook response qualification' and node.output_ref is not null`,
  );
  expect(steps.rows).toEqual(
    expect.arrayContaining([
      {
        trigger_type: 'webhook',
        output_ref: {
          kind: 'inline',
          value: { outcome: 'responded', statusCode: 201 },
        },
      },
      {
        trigger_type: 'manual',
        output_ref: {
          kind: 'inline',
          value: { outcome: 'not_waiting', statusCode: null },
        },
      },
      {
        trigger_type: 'webhook',
        output_ref: { kind: 'inline', value: { continued: true } },
      },
      {
        trigger_type: 'manual',
        output_ref: { kind: 'inline', value: { continued: true } },
      },
    ]),
  );
  const previews = await database.query(
    `select preview.output_ref from app.preview_runs preview join app.workflows workflow on workflow.id=preview.workflow_id where workflow.name='Webhook response qualification'`,
  );
  expect(previews.rows).toEqual([
    {
      output_ref: {
        kind: 'inline',
        value: { outcome: 'preview', statusCode: 201 },
      },
    },
  ]);
  const audits = await database.query('select metadata from app.audit_events');
  expect(JSON.stringify(audits.rows)).not.toContain('workflow-reply');
}
