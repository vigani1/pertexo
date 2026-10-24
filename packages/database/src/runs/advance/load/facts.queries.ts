import type { PoolClient } from 'pg';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from '@pertexo/workflow-model';
import { CoordinatorRunStateCorruptError } from '../contract.js';

import {
  attachPhysicalAttempts,
  readPhysicalAttempts,
  type PersistedCoordinatorEventRow,
} from './attempts.queries.js';
import { canonicalEventPayload, eventIdentity } from './fact-admission.js';
import type { EventRow } from './event-facts.queries.js';

export { canonicalTimestamp } from './fact-admission.js';
export {
  terminalStatus,
  mapEvent,
  completedInlineOutput,
  assertAvailableArtifacts,
} from './event-facts.queries.js';
export const maximumPersistedFacts = WORKFLOW_OBSERVATION_WINDOW_LIMITS.facts;

const maximumCanonicalPersistedFactBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS.canonicalWindowBytes;

// Keep each result bounded while avoiding a long-lived coordinator snapshot
// spending hundreds of network round trips on the accepted observation window.
const maximumPersistedFactRowsPerFetch = 1_000;

// This is a materialization target, not a protocol limit. A single accepted
// PostgreSQL JSON value may exceed it after numeric text expansion.
const targetPersistedFactWirePageBytes = 4 * 1_024 * 1_024;

export async function persistedFactCapacity(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  firstSequence: number,
): Promise<
  Readonly<{
    count: number;
    lastSequence: number;
    maximumStorageBytes: number;
    storageBytes: number;
  }>
> {
  const result = await client.query<{
    fact_count: number;
    last_sequence: number | null;
    maximum_storage_bytes: string;
    storage_bytes: string;
  }>(
    `select count(*)::int as fact_count, max(sequence)::int as last_sequence,
            coalesce(sum(octet_length(payload::text)),0)::bigint as storage_bytes,
            coalesce(max(octet_length(payload::text)),0)::bigint
              as maximum_storage_bytes
     from app.run_events
     where workspace_id=$1 and workflow_run_id=$2 and sequence >= $3`,
    [workspaceId, runId, firstSequence],
  );
  const row = result.rows[0];
  const count = row?.fact_count;
  const storageBytes = Number(row?.storage_bytes);
  const maximumStorageBytes = Number(row?.maximum_storage_bytes);
  const invalidCapacityObservation =
    count === undefined ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(storageBytes) ||
    !Number.isSafeInteger(maximumStorageBytes) ||
    count < 0 ||
    storageBytes < 0 ||
    maximumStorageBytes < 0 ||
    maximumStorageBytes > storageBytes;
  if (invalidCapacityObservation) throw new CoordinatorRunStateCorruptError();
  return Object.freeze({
    count,
    lastSequence: row?.last_sequence ?? firstSequence - 1,
    maximumStorageBytes,
    storageBytes,
  });
}

export async function readPersistedFacts(
  client: PoolClient,
  input: Readonly<{
    count: number;
    firstSequence: number;
    lastSequence: number;
    maximumStorageBytes: number;
    runId: string;
    workspaceId: string;
  }>,
): Promise<readonly EventRow[]> {
  const persistedEvents: PersistedCoordinatorEventRow[] = [];
  const identitiesBySequence = new Map<
    number,
    Readonly<{ attemptId: string; nodeRunId: string }>
  >();
  const attemptIds = new Set<string>();
  let canonicalBytes = 0;
  let nextSequence = input.firstSequence;
  const rowsPerFetch = Math.min(
    maximumPersistedFactRowsPerFetch,
    Math.max(
      1,
      Math.floor(
        targetPersistedFactWirePageBytes /
          Math.max(1, input.maximumStorageBytes),
      ),
    ),
  );
  while (persistedEvents.length < input.count) {
    const result = await client.query<PersistedCoordinatorEventRow>(
      `select event.sequence, event.type, event.payload, event.created_at
       from app.run_events event
       where event.workspace_id=$1 and event.workflow_run_id=$2
         and event.sequence >= $3
         and event.sequence <= $4
       order by event.sequence
       limit $5`,
      [
        input.workspaceId,
        input.runId,
        nextSequence,
        input.lastSequence,
        rowsPerFetch,
      ],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const canonical = canonicalEventPayload(row.payload);
      canonicalBytes += canonical.bytes;
      if (canonicalBytes > maximumCanonicalPersistedFactBytes)
        throw new CoordinatorRunStateCorruptError();
      const event = Object.freeze({ ...row, payload: canonical.payload });
      persistedEvents.push(event);
      if (row.type !== 'run.cancel_requested') {
        const identity = eventIdentity(canonical.payload);
        identitiesBySequence.set(row.sequence, identity);
        attemptIds.add(identity.attemptId);
      }
      nextSequence = row.sequence + 1;
    }
  }
  const physicalByAttemptId = await readPhysicalAttempts(
    client,
    input.workspaceId,
    input.runId,
    [...attemptIds],
  );
  return attachPhysicalAttempts(
    persistedEvents,
    identitiesBySequence,
    physicalByAttemptId,
  );
}
