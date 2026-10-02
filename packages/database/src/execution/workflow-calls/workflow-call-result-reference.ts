import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

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
  const reference = parseStoredExecutionValueV1(
    JSON.parse(row.reference_json) as unknown,
  );
  if (reference.kind === 'inline') {
    const bytes = row.serialized_value;
    if (
      bytes === null ||
      Buffer.byteLength(bytes, 'utf8') !== row.byte_length ||
      Buffer.byteLength(
        `{"kind":"inline","schemaVersion":1,"value":${bytes}}`,
        'utf8',
      ) > 262_144 ||
      createHash('sha256').update(bytes).digest('hex') !== row.value_checksum ||
      serializeWorkflowExecutionJsonValueV3(JSON.parse(bytes) as unknown) !==
        serializeStoredExecutionJsonValue(reference.value)
    )
      throw new TypeError('Workflow Call result bytes do not agree');
  } else {
    if (row.serialized_value !== null)
      throw new TypeError(
        'Workflow Call artifact result contains inline bytes',
      );
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
