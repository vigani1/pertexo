import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { runEvents } from '../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS } from '@pertexo/workflow-model';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';

import {
  attachPhysicalAttempts,
  readPhysicalAttempts,
  type PersistedCoordinatorEventRow,
} from './attempts.queries.js';
import { canonicalEventPayload, eventIdentity } from './fact-admission.js';
import type { EventRow } from './event-facts.queries.js';
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
  const [row] = await drizzle(client)
    .select({
      fact_count: sql<number>`count(*)::int`,
      last_sequence: sql<number | null>`max(${runEvents.sequence})::int`,
      storage_bytes: sql<string>`coalesce(sum(octet_length(${runEvents.payload}::text)),0)::bigint`,
      maximum_storage_bytes: sql<string>`coalesce(max(octet_length(${runEvents.payload}::text)),0)::bigint`,
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, workspaceId),
        eq(runEvents.workflowRunId, runId),
        gte(runEvents.sequence, firstSequence),
      ),
    )
    .catch(rethrowQueryFailure);
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
    const rows = await drizzle(client)
      .select({
        sequence: runEvents.sequence,
        type: runEvents.type,
        payload: runEvents.payload,
        created_at: runEvents.createdAt,
      })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.workspaceId, input.workspaceId),
          eq(runEvents.workflowRunId, input.runId),
          gte(runEvents.sequence, nextSequence),
          lte(runEvents.sequence, input.lastSequence),
        ),
      )
      .orderBy(runEvents.sequence)
      .limit(rowsPerFetch)
      .catch(rethrowQueryFailure);
    if (rows.length === 0) break;
    for (const row of rows) {
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
