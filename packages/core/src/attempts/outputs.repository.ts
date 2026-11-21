import { decodeStoredValue } from '../shared/stored-values.js';
import {
  withTenantScopedReadClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../shared/stored-execution.js';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, nodeAttempts } from '@pertexo/database/schema';
import type { Pool } from 'pg';
import {
  listStoredNodeRunOutcomes,
  readStoredNodeRunOutputs,
} from '../shared/run-records/node-run-outputs.repository.js';

import { NodeAttemptStateCorruptError } from './node-attempt.errors.js';
import type {
  NodeAttemptLoopDeclaration,
  NodeAttemptStoredOutput,
  NodeRunOutcome,
  NodeRunStoredOutput,
  ReadLoopDeclarationInput,
  ReadAttemptOutputsInput,
  ListNodeOutcomesInput,
  ReadNodeOutputsInput,
} from './node-attempt.js';

export async function readNodeAttemptLoopDeclaration(
  pool: Pool,
  input: ReadLoopDeclarationInput,
): Promise<NodeAttemptLoopDeclaration | undefined> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const declaration = await drizzle(client)
        .select({
          nodeId: nodeRuns.nodeId,
          attemptId: nodeAttempts.id,
          nodeOutput: nodeRuns.outputRef,
          attemptOutput: nodeAttempts.outputRef,
        })
        .from(nodeRuns)
        .innerJoin(
          nodeAttempts,
          and(
            eq(nodeAttempts.workspaceId, nodeRuns.workspaceId),
            eq(nodeAttempts.id, nodeRuns.currentAttemptId),
            eq(nodeAttempts.nodeRunId, nodeRuns.id),
          ),
        )
        .where(
          and(
            eq(nodeRuns.workspaceId, input.lease.workspaceId),
            eq(nodeRuns.workflowRunId, input.lease.runId),
            eq(nodeRuns.invocationKey, input.controlInvocationKey),
            eq(nodeAttempts.status, 'succeeded'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (declaration.length > 1) throw new NodeAttemptStateCorruptError();
      const row = declaration[0];
      if (row === undefined) return undefined;
      if (!storedExecutionValuesEqual(row.nodeOutput, row.attemptOutput))
        throw new NodeAttemptStateCorruptError();
      const stored = decodeStoredValue(() =>
        parseStoredExecutionValue(row.attemptOutput),
      );
      if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
      return Object.freeze({
        nodeId: row.nodeId,
        attemptId: row.attemptId,
        output: stored.value,
      });
    },
    { signal: input.signal },
  );
}

/** The stored outputs of succeeded attempts in the leased run, by attempt ID. */
export async function readNodeAttemptOutputs(
  pool: Pool,
  input: ReadAttemptOutputsInput,
): Promise<readonly NodeAttemptStoredOutput[]> {
  if (input.attemptIds.length === 0) return Object.freeze([]);
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const rows = await drizzle(client)
        .select({ attemptId: nodeAttempts.id, output: nodeAttempts.outputRef })
        .from(nodeAttempts)
        .innerJoin(
          nodeRuns,
          and(
            eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
            eq(nodeRuns.id, nodeAttempts.nodeRunId),
          ),
        )
        .where(
          and(
            eq(nodeAttempts.workspaceId, input.lease.workspaceId),
            eq(nodeRuns.workflowRunId, input.lease.runId),
            inArray(nodeAttempts.id, [...new Set(input.attemptIds)]),
            eq(nodeAttempts.status, 'succeeded'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (rows.length !== new Set(input.attemptIds).size)
        throw new NodeAttemptStateCorruptError();
      return Object.freeze(
        rows.map((row) => {
          const stored = decodeStoredValue(() =>
            parseStoredExecutionValue(row.output),
          );
          if (stored.kind !== 'inline')
            throw new NodeAttemptStateCorruptError();
          return Object.freeze({
            attemptId: row.attemptId,
            output: stored.value,
          });
        }),
      );
    },
    { signal: input.signal },
  );
}

export function listNodeRunOutcomes(
  pool: Pool,
  input: ListNodeOutcomesInput,
): Promise<readonly NodeRunOutcome[]> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    (client) => listStoredNodeRunOutcomes(client, input.lease, input.nodeId),
    { signal: input.signal },
  );
}

export function readNodeRunOutputs(
  pool: Pool,
  input: ReadNodeOutputsInput,
): Promise<readonly NodeRunStoredOutput[]> {
  if (input.invocationKeys.length === 0)
    return Promise.resolve(Object.freeze([]));
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const rows = await readStoredNodeRunOutputs(
        client,
        input.lease,
        input.invocationKeys,
      );
      if (rows === undefined) throw new NodeAttemptStateCorruptError();
      return rows;
    },
    { signal: input.signal },
  );
}
