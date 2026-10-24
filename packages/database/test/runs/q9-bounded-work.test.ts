import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { invocationKey } from '@pertexo/workflow-engine';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { NODE_ATTEMPT_INPUT_LIMITS } from '../../src/attempts/contract.js';
import { loadNodeAttemptInputs } from '../../src/attempts/inputs/load.queries.js';

const inline = (value: unknown) => ({
  kind: 'inline',
  value,
});

function recordMeasurement(input: {
  family: string;

  population: number;
  declaredUpperPopulation?: number;
  limitingConstraint?: string;
  upperSupportedPopulation: number;
  completedOperations: number;
  setupMs: number;
  operationMs: number;
  processHeapDeltaBytes: number;
  sql?: {
    applicationQueries: number;
    clientsAcquired: number;
    clientsReleased: number;
  };
}): void {
  console.info(
    `Q9_BOUNDED_WORK=${JSON.stringify({
      ...input,
      attributableMemory: {
        available: false,
        reason:
          'The probe shares a Vitest process and garbage collector; process heap delta is diagnostic, not attributable workload memory.',
        processHeapDeltaBytes: input.processHeapDeltaBytes,
      },
    })}`,
  );
}

function populations(upper: number): readonly number[] {
  return [...new Set([1, Math.ceil(upper / 2), upper])];
}

function baseCheckpoint(workflowVersionId: string) {
  return {
    workflowVersionId,
    revision: 0,
    runStatus: 'running',
    nextEventSequence: 1,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: [],
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
  } as const;
}

function lease(
  workflowVersionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    workspaceId: randomUUID(),
    runId: randomUUID(),
    workflowVersionId,
    nodeRunId: randomUUID(),
    attemptId: randomUUID(),
    attemptNumber: 1,
    admissionKind: 'execute' as const,
    invocationKey: 'current',
    nodeId: 'current',
    sideEffectClass: 'safe' as const,
    workerId: 'q9-bounded-probe',
    fenceToken: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    delivery: {
      outboxEventId: randomUUID(),
      payloadChecksum: 'a'.repeat(64),
    },
    ...overrides,
  };
}

function mockPool(input: {
  workspaceId: string;
  checkpoint: unknown;
  outputs?: readonly (readonly unknown[])[];
}) {
  let applicationQueries = 0;
  let clientsAcquired = 0;
  let contextActive = false;
  let releases = 0;
  const client = {
    query(query: string | { text: string }) {
      const sql = (typeof query === 'string' ? query : query.text).replaceAll(
        '"',
        '',
      );
      if (
        sql.includes("current_setting('app.workspace_id'") &&
        sql.includes('pg_settings')
      )
        return {
          rows: [
            {
              workspace_id: input.workspaceId,
              actor_id: null,
              statement_timeout_millis: 0,
            },
          ],
        };
      if (sql.includes("current_setting('app.workspace_id'"))
        return {
          rows: [
            {
              workspace_id: contextActive ? input.workspaceId : null,
              actor_id: null,
            },
          ],
        };
      if (sql.startsWith('begin')) return { rows: [] };
      if (sql.includes("set_config('app.workspace_id'")) {
        contextActive = true;
        return { rows: [] };
      }
      if (sql === 'commit') {
        contextActive = false;
        return { rows: [] };
      }
      if (sql === 'rollback') {
        contextActive = false;
        return { rows: [] };
      }
      if (sql.includes('from app.workflow_runs')) {
        applicationQueries += 1;
        return {
          rows: [[inline(null), null, null, input.checkpoint, false, null]],
        };
      }
      if (sql.includes('from app.node_runs')) {
        applicationQueries += 1;
        return { rows: input.outputs ?? [] };
      }
      throw new Error(`Unexpected Q9 probe query: ${sql}`);
    },
    release() {
      releases += 1;
    },
  };
  return {
    pool: {
      connect: () => {
        clientsAcquired += 1;
        return Promise.resolve(client);
      },
    } as unknown as Pool,
    measurements: () => ({ applicationQueries, clientsAcquired, releases }),
  };
}

describe('Q9 bounded-work probes', () => {
  it.each(populations(NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs))(
    'keeps %i upstream outputs in one batched lookup',
    async (population) => {
      const setupStarted = performance.now();
      const workflowVersionId = randomUUID();
      const attemptLease = lease(workflowVersionId);
      const upstreamNodeOutputs = Array.from(
        { length: population },
        (_, index) => {
          const nodeId = `upstream-${String(index)}`;
          return {
            nodeId,
            invocationKey: invocationKey({
              workflowVersionId,
              nodeId,
            }),
          };
        },
      );
      const rows = upstreamNodeOutputs.map(
        ({ nodeId, invocationKey }, index) => {
          const stored = inline({ index });
          // PostgreSQL's array row mode follows the selected field order.
          return [
            randomUUID(),
            1,
            null,
            null,
            null,
            'succeeded',
            invocationKey,
            nodeId,
            stored,
            stored,
          ];
        },
      );
      const harness = mockPool({
        workspaceId: attemptLease.workspaceId,
        checkpoint: baseCheckpoint(workflowVersionId),
        outputs: rows,
      });
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const result = await loadNodeAttemptInputs(harness.pool, {
        lease: attemptLease,
        upstreamNodeOutputs,
        signal: new AbortController().signal,
      });
      const elapsedMs = performance.now() - started;
      const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      expect(result.completedNodeOutputs).toHaveLength(population);
      const work = harness.measurements();
      expect(work).toEqual({
        applicationQueries: 2,
        clientsAcquired: 1,
        releases: 1,
      });
      recordMeasurement({
        family: 'input-assembly',

        population,
        upperSupportedPopulation: NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs,
        completedOperations: population,
        setupMs,
        operationMs: elapsedMs,
        processHeapDeltaBytes: heapDeltaBytes,
        sql: {
          applicationQueries: work.applicationQueries,
          clientsAcquired: work.clientsAcquired,
          clientsReleased: work.releases,
        },
      });
    },
  );

  // The 256-byte durable invocation key is the tighter bound than the graph's
  // depth-32 structural parser for this fully materialized scope identity.
});
