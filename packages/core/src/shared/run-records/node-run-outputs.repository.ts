import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { nodeRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { decodeStoredValue } from '../stored-values.js';
import { parseStoredExecutionValue } from '../stored-execution.js';

type RunScope = Readonly<{ workspaceId: string; runId: string }>;

export async function listStoredNodeRunOutcomes(
  client: PoolClient,
  scope: RunScope,
  nodeId: string,
) {
  const rows = await drizzle(client)
    .select({
      invocationKey: nodeRuns.invocationKey,
      status: sql<'succeeded' | 'skipped'>`${nodeRuns.status}`,
      outputBytes: sql<number>`coalesce(octet_length(${nodeRuns.outputRef}::text),0)::int`,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, scope.workspaceId),
        eq(nodeRuns.workflowRunId, scope.runId),
        eq(nodeRuns.nodeId, nodeId),
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
}

/** The stored outputs of succeeded step runs in this run, by invocation key. */
export async function readStoredNodeRunOutputs(
  client: PoolClient,
  scope: RunScope,
  invocationKeys: readonly string[],
) {
  const keys = [...new Set(invocationKeys)];
  if (keys.length === 0) return Object.freeze([]);
  const rows = await drizzle(client)
    .select({
      invocationKey: nodeRuns.invocationKey,
      output: nodeRuns.outputRef,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, scope.workspaceId),
        eq(nodeRuns.workflowRunId, scope.runId),
        inArray(nodeRuns.invocationKey, keys),
        eq(nodeRuns.status, 'succeeded'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (rows.length !== keys.length) return undefined;
  const outputs = [];
  for (const row of rows) {
    const stored = decodeStoredValue(() =>
      parseStoredExecutionValue(row.output),
    );
    if (stored.kind !== 'inline') return undefined;
    outputs.push(
      Object.freeze({ invocationKey: row.invocationKey, output: stored.value }),
    );
  }
  return Object.freeze(outputs);
}
