import type { PoolClient } from 'pg';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';

/** Read immutable accepted-child result truth without child/ancestor row locks. */
export async function readWorkflowCallResultReference(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    parentRunId: string;
    invocationKey: string;
    childRunId: string;
  }>,
): Promise<string> {
  const result = await client.query<{
    reference_json: string;
    serialized_value: string | null;
    byte_length: number;
    value_checksum: string;
  }>(
    `select reference_json,serialized_value,byte_length,value_checksum from app.read_workflow_call_result_reference($1::uuid,$2::text,$3::uuid)`,
    [input.parentRunId, input.invocationKey, input.childRunId],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    Buffer.byteLength(row.reference_json, 'utf8') > 4_194_304
  )
    throw new TypeError('Workflow Call result provenance is missing');
  const { reference } = parseWorkflowExecutionValueSnapshot({
    reference: JSON.parse(row.reference_json) as unknown,
    sha256: row.value_checksum,
    byteLength: row.byte_length,
    ...(row.serialized_value === null
      ? {}
      : { serializedValue: row.serialized_value }),
  });
  if (reference.kind === 'artifact') {
    const available = await client.query(
      `select id from app.artifacts where workspace_id=$1 and id=$2 and status='available' and deleted_at is null`,
      [input.workspaceId, reference.artifactId],
    );
    if (available.rows.length !== 1)
      throw new TypeError('Workflow Call result artifact is unavailable');
  }
  // Preserve PostgreSQL's first reference projection, including rounded numerics.
  return row.reference_json;
}
