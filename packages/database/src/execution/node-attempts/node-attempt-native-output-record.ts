import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { workflowCallAttemptAuthorityJson } from './node-attempt-call-input-record.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';

/** Original physical output bytes, before the existing first JSONB projection. */
export async function recordNativeAttemptInlineOutput(
  client: PoolClient,
  lease: Parameters<typeof workflowCallAttemptAuthorityJson>[0],
  output: unknown,
  reference: string,
): Promise<void> {
  const bytes = serializeStoredExecutionJsonValue(output);
  await client.query(
    `select app.record_native_workflow_attempt_output(
      $1::jsonb,$2::jsonb,$3::text,$4::integer,$5::text
    )`,
    [
      workflowCallAttemptAuthorityJson(lease),
      reference,
      createHash('sha256').update(bytes).digest('hex'),
      Buffer.byteLength(bytes, 'utf8'),
      bytes,
    ],
  );
}
