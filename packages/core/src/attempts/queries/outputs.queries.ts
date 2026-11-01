import {
  withTenantScopedReadClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../runs/values/stored-execution.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, nodeAttempts } from '@pertexo/database/schema';
import type { Pool } from 'pg';

import { NodeAttemptStateCorruptError } from '../errors.js';
import type {
  NodeAttemptLoopDeclaration,
  NodeAttemptStoredOutput,
  NodeRunOutcome,
  NodeRunStoredOutput,
  NodeAttemptRunStore,
} from '../contract.js';

export async function readNodeAttemptLoopDeclaration(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
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
      const stored = parseStoredExecutionValue(row.attemptOutput);
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
  input: Parameters<NodeAttemptRunStore['readAttemptOutputs']>[0],
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
          const stored = parseStoredExecutionValue(row.output);
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

export async function listNodeRunOutcomes(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['listNodeOutcomes']>[0],
): Promise<readonly NodeRunOutcome[]> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const rows = await drizzle(client)
        .select({
          invocationKey: nodeRuns.invocationKey,
          status: sql<NodeRunOutcome['status']>`${nodeRuns.status}`,
          outputBytes: sql<number>`coalesce(octet_length(${nodeRuns.outputRef}::text),0)::int`,
        })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.workspaceId, input.lease.workspaceId),
            eq(nodeRuns.workflowRunId, input.lease.runId),
            eq(nodeRuns.nodeId, input.nodeId),
            inArray(nodeRuns.status, ['succeeded', 'skipped']),
          ),
        )
        .catch(rethrowQueryFailure);
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            invocationKey: row.invocationKey,
            status: row.status,
            outputBytes: row.outputBytes,
          }),
        ),
      );
    },
    { signal: input.signal },
  );
}

/** The stored outputs of succeeded step runs in the leased run, by key. */
export async function readNodeRunOutputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readNodeOutputs']>[0],
): Promise<readonly NodeRunStoredOutput[]> {
  const keys = [...new Set(input.invocationKeys)];
  if (keys.length === 0) return Object.freeze([]);
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const rows = await drizzle(client)
        .select({
          invocationKey: nodeRuns.invocationKey,
          output: nodeRuns.outputRef,
        })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.workspaceId, input.lease.workspaceId),
            eq(nodeRuns.workflowRunId, input.lease.runId),
            inArray(nodeRuns.invocationKey, keys),
            eq(nodeRuns.status, 'succeeded'),
          ),
        )
        .catch(rethrowQueryFailure);
      if (rows.length !== keys.length) throw new NodeAttemptStateCorruptError();
      return Object.freeze(
        rows.map((row) => {
          const stored = parseStoredExecutionValue(row.output);
          if (stored.kind !== 'inline')
            throw new NodeAttemptStateCorruptError();
          return Object.freeze({
            invocationKey: row.invocationKey,
            output: stored.value,
          });
        }),
      );
    },
    { signal: input.signal },
  );
}
