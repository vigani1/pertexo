import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { workflowCallAttemptAuthorityJson } from './node-attempt-call-input-record.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';
import type { parseWorkflowExecutionValueSnapshot } from './node-attempt-call-input-record.js';
import { NodeAttemptStateCorruptError } from './node-attempt-run-store-contract.js';

/** Replay compares immutable accepted physical identity, never the current logical output. */
export async function assertNativeAttemptArtifactOutputReplay(
  client: PoolClient,
  lease: Parameters<typeof workflowCallAttemptAuthorityJson>[0],
  snapshot: ReturnType<typeof parseWorkflowExecutionValueSnapshot>,
  reference: string,
): Promise<void> {
  const result = await client.query<{ matches: boolean }>(
    'select app.native_attempt_artifact_output_replay_matches($1::jsonb,$2::jsonb,$3::text,$4::integer) as matches',
    [
      workflowCallAttemptAuthorityJson(lease),
      reference,
      snapshot.sha256,
      snapshot.byteLength,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true)
    throw new NodeAttemptStateCorruptError();
}

/** Already reconciled producer metadata; actual SQL owner proves current acceptance. */
export async function recordNativeAttemptPreparedOutput(
  client: PoolClient,
  lease: Parameters<typeof workflowCallAttemptAuthorityJson>[0],
  snapshot: ReturnType<typeof parseWorkflowExecutionValueSnapshot>,
  reference: string,
): Promise<void> {
  await client.query(
    `select app.record_native_workflow_attempt_output(
      $1::jsonb,$2::jsonb,$3::text,$4::integer,$5::text
    )`,
    [
      workflowCallAttemptAuthorityJson(lease),
      reference,
      snapshot.sha256,
      snapshot.byteLength,
      snapshot.serializedValue ?? null,
    ],
  );
}

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
