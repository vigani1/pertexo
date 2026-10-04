import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { loadInputsSchema } from './node-attempt-run-store-contract.js';
import type { NodeAttemptRunStore } from './node-attempt-run-store-contract.js';
import { parseNativeNodeAttemptValueSource } from './native-node-attempt-value-sources.js';
import { workflowCallAttemptAuthorityJson } from './node-attempt-call-input-record.js';
import {
  assertNotAborted,
  withWorkspaceReadClient,
} from './node-attempt-run-store-transactions.js';

/** Selected current consumer reread, not reference possession authorization. */
export async function readNativeAttemptValueSource(
  pool: Pool,
  input: Parameters<
    NonNullable<NodeAttemptRunStore['readNativeValueSource']>
  >[0],
) {
  assertNotAborted(input.signal);
  const lease = loadInputsSchema.shape.lease.parse(input.lease);
  const requested = parseNativeNodeAttemptValueSource(input.source);
  const selection =
    requested.slot === 'run_input'
      ? { slot: 'run_input' }
      : requested.slot === 'wait_resume_output'
        ? { slot: 'wait_resume_output' }
        : {
            slot: 'upstream_output',
            nodeId: requested.source.nodeId,
            invocationKey: requested.source.invocationKey,
          };
  return withWorkspaceReadClient(
    pool,
    lease.workspaceId,
    input.signal,
    async (client) => {
      assertNotAborted(input.signal);
      const result = await client.query<{ source: unknown }>(
        'select app.read_native_attempt_value_source($1::jsonb,$2::jsonb) as source',
        [workflowCallAttemptAuthorityJson(lease), JSON.stringify(selection)],
      );
      assertNotAborted(input.signal);
      if (result.rows.length !== 1)
        throw new TypeError('Native attempt accepted source is missing');
      const accepted = parseNativeNodeAttemptValueSource(
        result.rows[0]?.source,
      );
      if (
        accepted.slot !== requested.slot ||
        !isDeepStrictEqual(accepted.source, requested.source)
      )
        throw new TypeError(
          'Native attempt independently accepted source scope differs',
        );
      return accepted;
    },
  );
}
