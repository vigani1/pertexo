import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns, nodeAttempts } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool } from 'pg';

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLoopDeclaration,
  type NodeAttemptStoredOutput,
  type NodeRunOutcome,
  type NodeRunStoredOutput,
  type NodeAttemptRunStore,
} from '../contract.js';
import {
  assertNotAborted,
  withWorkspaceReadClient,
} from '../transactions.repository.js';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../platform/stored-execution-value.js';

export async function readNodeAttemptLoopDeclaration(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
): Promise<NodeAttemptLoopDeclaration | undefined> {
  assertNotAborted(input.signal);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
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
  );
}

/** The stored outputs of succeeded attempts in the leased run, by attempt ID. */
export async function readNodeAttemptOutputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readAttemptOutputs']>[0],
): Promise<readonly NodeAttemptStoredOutput[]> {
  assertNotAborted(input.signal);
  if (input.attemptIds.length === 0) return Object.freeze([]);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
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
  );
}

export async function listNodeRunOutcomes(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['listNodeOutcomes']>[0],
): Promise<readonly NodeRunOutcome[]> {
  assertNotAborted(input.signal);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
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
  );
}

/** The stored outputs of succeeded step runs in the leased run, by key. */
export async function readNodeRunOutputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readNodeOutputs']>[0],
): Promise<readonly NodeRunStoredOutput[]> {
  assertNotAborted(input.signal);
  const keys = [...new Set(input.invocationKeys)];
  if (keys.length === 0) return Object.freeze([]);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
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
  );
}
