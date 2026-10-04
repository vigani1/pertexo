import type { PoolClient } from 'pg';
import { parseWorkflowExecutionValueSnapshot } from '../node-attempts/node-attempt-call-input-record.js';
import type { NativeCoordinatorValueOwner } from '../coordinator/coordinator-native-value-read-contract.js';

/** Validate accepted identity without fetching result bytes or granting a demand read. */
export async function assertWorkflowCallResultOutput(
  client: PoolClient,
  input: Readonly<{
    parentRunId: string;
    invocationKey: string;
    childRunId: string;
    compareLogicalNode: boolean;
  }>,
): Promise<void> {
  const result = await client.query<{ matches: boolean }>(
    `select app.assert_workflow_call_result_output($1::uuid,$2::text,$3::uuid,$4::boolean) as matches`,
    [
      input.parentRunId,
      input.invocationKey,
      input.childRunId,
      input.compareLogicalNode,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.matches !== true)
    throw new TypeError('Workflow Call result accepted identity differs');
}

/** Read immutable accepted-child result truth without child/ancestor row locks. */
export async function readWorkflowCallResultReference(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    parentRunId: string;
    invocationKey: string;
    childRunId: string;
    consumer?: NativeCoordinatorValueOwner;
  }>,
): Promise<string> {
  if (input.consumer === undefined)
    throw new TypeError(
      'Native accepted-result consumer authority is unavailable',
    );
  if (
    input.consumer.workspaceId !== input.workspaceId ||
    input.consumer.runId !== input.parentRunId
  )
    throw new TypeError('Native accepted-result consumer scope differs');
  const result = await client.query<{
    reference_json: string;
    serialized_value: string | null;
    byte_length: number;
    value_checksum: string;
  }>(
    `select reference_json,serialized_value,byte_length,value_checksum from app.read_workflow_call_result_reference($1::uuid,$2::text,$3::uuid,$4::jsonb)`,
    [
      input.parentRunId,
      input.invocationKey,
      input.childRunId,
      JSON.stringify(input.consumer),
    ],
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
