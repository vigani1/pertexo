import type { Pool } from 'pg';
import {
  CoordinatorRunStateCorruptError,
  coordinatorIdentitySchema,
  coordinatorDeliverySchema,
  type LoadAdvanceStateInput,
  type LoadAdvanceStateResult,
} from './coordinator-run-store-contract.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorReadClient,
  withCoordinatorWriteClient,
} from './coordinator-run-store-transactions.js';
import { applyCoordinatorCallControl } from './coordinator-call-controls.js';
import { coordinatorExecutableFormat } from './coordinator-checkpoint.js';
import { assertNativeCoordinatorPoolAdmission } from './coordinator-executable-capability.js';
import {
  loadCoordinatorAdvanceSnapshot,
  type NativeObservationAdapter,
} from './coordinator-advance-snapshot.js';
export {
  canonicalTimestamp,
  mapEvent,
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
  record,
  terminalStatus,
  validatePersistedFactBatch,
} from './coordinator-run-store-observation-facts.js';

export async function loadCoordinatorAdvanceState(
  pool: Pool,
  input: LoadAdvanceStateInput,
  /** Internal release-admitted adapter selection, never inferred from a row. */
  nativeAdapter?: NativeObservationAdapter,
): Promise<LoadAdvanceStateResult> {
  assertCoordinatorNotAborted(input.signal);
  const workspaceId = coordinatorIdentitySchema.parse(input.workspaceId);
  const runId = coordinatorIdentitySchema.parse(input.runId);
  const nativeControlReadTimeoutMillis =
    nativeAdapter?.controlReadTimeoutMillis;
  if (nativeAdapter !== undefined) {
    if (nativeAdapter.capability.nativeReleases.length === 0)
      throw new TypeError(
        'Native observation adapter has no supported release',
      );
    assertNativeCoordinatorPoolAdmission(
      pool.options.connectionTimeoutMillis,
      nativeAdapter.controlReadTimeoutMillis,
    );
  }
  // Classification contains bounded metadata ONLY, even on a retained-only
  // adapter. An unknown/native format cannot enter an ordinary payload read.
  const classified = await withCoordinatorReadClient(
    pool,
    workspaceId,
    input.signal,
    async (client) => {
      const result = await client.query<{
        graph_schema_version: number | null;
        executable_schema_version: number | null;
        executable_checksum: string | null;
      }>(
        `select version.schema_version as graph_schema_version,
                version.executable_schema_version,version.checksum as executable_checksum
           from app.workflow_runs run left join app.workflow_versions version
             on version.workspace_id=run.workspace_id and version.id=run.workflow_version_id
          where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, runId],
      );
      if (result.rows.length > 1) throw new CoordinatorRunStateCorruptError();
      return result.rows[0];
    },
    nativeControlReadTimeoutMillis,
  );
  if (classified === undefined) return Object.freeze({ kind: 'not_found' });
  const classifiedFormat = coordinatorExecutableFormat(classified);
  if (
    classifiedFormat === undefined ||
    (classifiedFormat === 3 && nativeControlReadTimeoutMillis === undefined)
  )
    return Object.freeze({ kind: 'not_executable' });
  const delivery =
    classifiedFormat === 3
      ? coordinatorDeliverySchema.parse(input.delivery)
      : undefined;
  if (delivery !== undefined) {
    await withCoordinatorWriteClient(
      pool,
      workspaceId,
      input.signal,
      (client) =>
        applyCoordinatorCallControl(client, { workspaceId, runId, delivery }),
    );
  }
  return withCoordinatorReadClient(
    pool,
    workspaceId,
    input.signal,
    (client) =>
      loadCoordinatorAdvanceSnapshot(client, {
        workspaceId,
        runId,
        signal: input.signal,
        classifiedFormat,
        delivery,
        nativeAdapter,
      }),
    nativeControlReadTimeoutMillis,
  );
}
