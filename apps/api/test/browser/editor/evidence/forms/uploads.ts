import type { Pool } from 'pg';
import { expect } from 'vitest';

const file = (filename: string) => ({
  file: {
    kind: 'artifact',
    artifactId: expect.any(String) as unknown,
    byteLength: expect.any(Number) as unknown,
    mediaType: expect.any(String) as unknown,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
  },
  filename,
});

/** Both responses carried their files into finished runs; refusals stored nothing. */
export async function verifyFormUploadEvidence(database: Pool) {
  const runs = await database.query<{
    started_by: string | null;
    input_ref: unknown;
    read_ref: unknown;
    output_ref: unknown;
  }>(
    `select run.started_by,run.input_ref,read.output_ref read_ref,finish.output_ref
     from app.workflow_runs run
     join app.node_runs read on read.workspace_id=run.workspace_id and read.workflow_run_id=run.id and read.node_id='read'
     join app.node_runs finish on finish.workspace_id=run.workspace_id and finish.workflow_run_id=run.id and finish.node_id='finish'
     where run.trigger_type='form' and run.status='succeeded' order by run.created_at`,
  );
  expect(runs.rows).toHaveLength(2);
  for (const [index, shop] of ['Corner shop', 'Main street'].entries())
    expect(runs.rows[index]).toMatchObject({
      started_by: index === 0 ? null : (expect.any(String) as unknown),
      input_ref: {
        kind: 'inline',
        value: { values: { shop, orders: [file('orders.csv')] } },
      },
      read_ref: {
        kind: 'inline',
        value: [
          { sku: 'A-1', qty: 2 },
          { sku: 'B-2', qty: 5 },
        ],
      },
      output_ref: {
        kind: 'inline',
        value: { signed: [file('signed-note.pdf')] },
      },
    });
  const uploads = await database.query<{
    purpose: string;
    status: string;
    filename: string;
    field_id: string;
    by_link: boolean;
    by_member: boolean;
    for_task: boolean;
  }>(
    `select artifact.purpose,artifact.status,upload.filename,upload.field_id,
       upload.capability_hash is not null by_link,
       upload.uploaded_by is not null by_member,
       upload.task_id is not null for_task
     from app.form_uploads upload
     join app.artifacts artifact on artifact.workspace_id=upload.workspace_id and artifact.id=upload.artifact_id
     order by upload.created_at`,
  );
  // The 1.5 MB export was refused before any reservation.
  expect(uploads.rows).toEqual(
    [
      ['orders.csv', 'orders', true, false, false],
      ['signed-note.pdf', 'signed', false, true, true],
      ['orders.csv', 'orders', false, true, false],
      ['signed-note.pdf', 'signed', false, true, true],
    ].map(([filename, field_id, by_link, by_member, for_task]) => ({
      purpose: 'form-upload',
      status: 'available',
      filename,
      field_id,
      by_link,
      by_member,
      for_task,
    })),
  );
  const audits = await database.query('select metadata from app.audit_events');
  expect(JSON.stringify(audits.rows)).not.toContain('orders.csv');
}
