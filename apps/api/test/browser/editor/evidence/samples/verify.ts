import { verifyDraftTestEvidence } from './draft-tests.js';
import type { Pool } from 'pg';
import { expect } from 'vitest';
export async function verifySampleEvidence(database: Pool) {
  await verifyDraftTestEvidence(database);
  const previews = await database.query<{
    id: string;
    pinned_sample_id: string | null;
    output_ref: unknown;
    started_at: Date | null;
    status: string;
  }>(
    "select preview.id,preview.pinned_sample_id,preview.output_ref,preview.started_at,preview.status from app.preview_runs preview join app.workflows workflow on workflow.id=preview.workflow_id where workflow.name='Pinned sample qualification' order by preview.created_at,preview.id",
  );
  const pinned = previews.rows.filter((row) => row.pinned_sample_id !== null);
  expect(pinned).toHaveLength(2);
  for (const preview of pinned) {
    expect(preview).toMatchObject({
      status: 'succeeded',
      started_at: null,
      output_ref: { kind: 'inline', value: { proof: 'pinned-data' } },
    });
    expect(
      (
        await database.query(
          'select id from app.preview_attempts where preview_run_id=$1 union all select id from app.outbox_events where aggregate_id=$1',
          [preview.id],
        )
      ).rows,
    ).toEqual([]);
  }
  const real = previews.rows.filter((row) => row.pinned_sample_id === null);
  expect(real).toHaveLength(2);
  expect(real[0]?.output_ref).toEqual({
    kind: 'inline',
    value: { proof: 'real-preview' },
  });
  expect(real[1]?.output_ref).toEqual({
    kind: 'inline',
    value: { proof: 'pinned-data' },
  });
  expect(
    (
      await database.query(
        "select sample.id from app.workflow_step_samples sample join app.workflows workflow on workflow.id=sample.workflow_id where workflow.name='Pinned sample qualification'",
      )
    ).rows,
  ).toEqual([]);
  const audits = await database.query(
    "select metadata from app.audit_events where action like 'workflow.sample.%'",
  );
  expect(audits.rows.length).toBeGreaterThanOrEqual(5);
  expect(JSON.stringify(audits.rows)).not.toContain('pinned-data');
}
