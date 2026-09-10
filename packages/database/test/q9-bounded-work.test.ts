import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';

import {
  parsePersistedWorkflowCheckpoint,
  PERSISTED_WORKFLOW_CHECKPOINT_LIMITS,
} from '../src/compatibility/persisted-workflow-checkpoint.js';
import { NODE_ATTEMPT_INPUT_LIMITS } from '../src/execution/node-attempt-run-store-contract.js';
import { loadNodeAttemptInputs } from '../src/execution/node-attempt-run-store-inputs.js';
import { scopedInvocationKey } from '../src/execution/node-attempt-run-store-transactions.js';
import { serializeStoredExecutionJsonValue } from '../src/execution/stored-execution-value.js';

const inline = (value: unknown) => ({
  schemaVersion: 1,
  kind: 'inline',
  value,
});

function recordMeasurement(input: {
  family: string;
  contractVersion: string;
  population: number;
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
    `Q9_BOUNDED_WORK_V1=${JSON.stringify({
      schemaVersion: 1,
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

function largestAcceptedPopulation(
  declaredMaximum: number,
  checkpoint: (population: number) => unknown,
): number {
  let accepted = 0;
  let rejected = declaredMaximum + 1;
  while (accepted + 1 < rejected) {
    const candidate = Math.floor((accepted + rejected) / 2);
    try {
      parsePersistedWorkflowCheckpoint(checkpoint(candidate));
      accepted = candidate;
    } catch {
      rejected = candidate;
    }
  }
  return accepted;
}

const structuredScopeNodeIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'.split('');
const structuredScopeUpperSupportedPopulation = (() => {
  const workflowVersionId = '00000000-0000-4000-8000-000000000001';
  const declaredMaximum = Math.min(
    WORKFLOW_GRAPH_LIMITS.structuredDepth,
    PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts,
    structuredScopeNodeIds.length,
  );
  let accepted = 0;
  for (let population = 1; population <= declaredMaximum; population += 1) {
    const iterationPath = structuredScopeNodeIds
      .slice(0, population)
      .map((loopNodeId) => ({ loopNodeId, ordinal: 0 }));
    if (
      Buffer.byteLength(
        scopedInvocationKey({
          workflowVersionId,
          nodeId: 'body',
          iterationPath,
        }),
      ) > PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocationKeyBytes
    )
      break;
    accepted = population;
  }
  return accepted;
})();

function baseCheckpoint(workflowVersionId: string) {
  return {
    schemaVersion: 1,
    engineVersion: '1',
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
  } as const;
}

function invocationCheckpoint(population: number, workflowVersionId: string) {
  return {
    ...baseCheckpoint(workflowVersionId),
    schemaVersion: 2 as const,
    invocations: Array.from({ length: population }, (_, index) => ({
      invocationKey: `invocation-${String(index)}`,
      nodeId: `node-${String(index)}`,
      status: 'pending' as const,
      attemptNumber: 0,
    })),
    branchSelections: [],
    initialIterationBudget: 0,
  };
}

function joinCheckpoint(population: number, workflowVersionId: string) {
  const joins = Array.from({ length: population }, (_, index) => {
    const joinId = `join-${String(index)}`;
    return {
      joinInvocationKey: scopedInvocationKey({
        workflowVersionId,
        nodeId: joinId,
      }),
      joinId,
      policy: { kind: 'all' as const },
      ledger: [{ branchId: 'branch', disposition: 'pending' as const }],
    };
  });
  return {
    ...baseCheckpoint(workflowVersionId),
    schemaVersion: 2 as const,
    invocations: joins.map((join) => ({
      invocationKey: join.joinInvocationKey,
      nodeId: join.joinId,
      status: 'pending' as const,
      attemptNumber: 0,
    })),
    joins,
    branchSelections: [],
    initialIterationBudget: 0,
  };
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
  outputs?: readonly {
    invocation_key: string;
    node_id: string;
    node_output_ref: unknown;
    attempt_output_ref: unknown;
  }[];
  declaration?: {
    attempt_id: string;
    attempt_output_ref: unknown;
    node_output_ref: unknown;
    node_id: string;
  };
}) {
  let applicationQueries = 0;
  let clientsAcquired = 0;
  let contextActive = false;
  let releases = 0;
  const client = {
    query(sql: string) {
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
      if (sql.includes('from app.workflow_runs run')) {
        applicationQueries += 1;
        return {
          rows: [
            {
              abort_reason: null,
              abort_requested: false,
              deadline_at: null,
              input_ref: inline(null),
              scheduler_state: input.checkpoint,
            },
          ],
        };
      }
      if (sql.includes('invocation_key=any')) {
        applicationQueries += 1;
        return { rows: input.outputs ?? [] };
      }
      if (sql.includes('node.current_attempt_id as attempt_id')) {
        applicationQueries += 1;
        return {
          rows: input.declaration === undefined ? [] : [input.declaration],
        };
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
            invocationKey: scopedInvocationKey({ workflowVersionId, nodeId }),
          };
        },
      );
      const rows = upstreamNodeOutputs.map(
        ({ nodeId, invocationKey }, index) => {
          const stored = inline({ index });
          return {
            invocation_key: invocationKey,
            node_id: nodeId,
            node_output_ref: stored,
            attempt_output_ref: stored,
          };
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
        contractVersion: 'node-attempt-input-v1',
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

  it('measures small, intermediate and effective-upper V2 invocation populations', () => {
    const derivationIdentity = randomUUID();
    const upperSupportedPopulation = largestAcceptedPopulation(
      PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocations,
      (population) => invocationCheckpoint(population, derivationIdentity),
    );
    expect(upperSupportedPopulation).toBeGreaterThan(1);
    for (const population of populations(upperSupportedPopulation)) {
      const setupStarted = performance.now();
      const checkpoint = invocationCheckpoint(population, randomUUID());
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const parsed = parsePersistedWorkflowCheckpoint(checkpoint);
      const operationMs = performance.now() - started;
      const processHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      expect(parsed.invocations).toHaveLength(population);
      recordMeasurement({
        family: 'checkpoint-invocation-validation-projection',
        contractVersion: 'persisted-workflow-checkpoint-v2',
        population,
        upperSupportedPopulation,
        completedOperations: parsed.invocations.length,
        setupMs,
        operationMs,
        processHeapDeltaBytes,
      });
    }
  });

  it('measures small, intermediate and effective-upper V2 join populations', () => {
    const derivationIdentity = randomUUID();
    const upperSupportedPopulation = largestAcceptedPopulation(
      PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.joins,
      (population) => joinCheckpoint(population, derivationIdentity),
    );
    expect(upperSupportedPopulation).toBeGreaterThan(1);
    for (const population of populations(upperSupportedPopulation)) {
      const setupStarted = performance.now();
      const checkpoint = joinCheckpoint(population, randomUUID());
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const parsed = parsePersistedWorkflowCheckpoint(checkpoint);
      const operationMs = performance.now() - started;
      const processHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      expect(parsed.joins).toHaveLength(population);
      recordMeasurement({
        family: 'checkpoint-join-validation-projection',
        contractVersion: 'persisted-workflow-checkpoint-v2',
        population,
        upperSupportedPopulation,
        completedOperations: parsed.joins.length,
        setupMs,
        operationMs,
        processHeapDeltaBytes,
      });
    }
  });

  // The 256-byte durable invocation key is the tighter bound than the graph's
  // depth-32 structural parser for this fully materialized scope identity.
  it.each(populations(structuredScopeUpperSupportedPopulation))(
    'selects the nearest declaration for %i nested structured scopes with one lookup',
    async (population) => {
      const setupStarted = performance.now();
      const workflowVersionId = randomUUID();
      const loopIds = structuredScopeNodeIds.slice(0, population);
      const scopes = loopIds.map((loopNodeId) => ({ loopNodeId, ordinal: 0 }));
      const collection = [0];
      const checksum = createHash('sha256')
        .update(serializeStoredExecutionJsonValue(collection))
        .digest('hex');
      const loops = loopIds.map((loopId, index) => {
        const iterationPath = scopes.slice(0, index);
        const attemptId = randomUUID();
        return {
          controlInvocationKey: scopedInvocationKey({
            workflowVersionId,
            nodeId: loopId,
            iterationPath,
          }),
          loopId,
          branchPath: [],
          iterationPath,
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: { kind: 'inline' as const, attemptId },
          collectionChecksum: checksum,
          collectionSize: 1,
          maxConcurrency: 1,
          maxIterations: 1,
          nextOrdinal: 1,
          activeOrdinals: [0],
          terminalOrdinals: [],
        };
      });
      const checkpoint = {
        ...baseCheckpoint(workflowVersionId),
        schemaVersion: 2 as const,
        invocations: loops.map((loop) => ({
          invocationKey: loop.controlInvocationKey,
          nodeId: loop.loopId,
          status: 'waiting' as const,
          attemptNumber: 1,
          iterationPath: loop.iterationPath,
          output: loop.collection,
        })),
        loops,
        branchSelections: [],
        remainingIterationBudget: 0,
        initialIterationBudget: population,
      };
      const nearest = loops.at(-1);
      if (nearest === undefined) throw new Error('missing nearest loop');
      const stored = inline({ items: collection, iterationCount: 1 });
      const attemptLease = lease(workflowVersionId, {
        invocationKey: scopedInvocationKey({
          workflowVersionId,
          nodeId: 'body',
          iterationPath: scopes,
        }),
        nodeId: 'body',
        iterationPath: scopes,
      });
      const harness = mockPool({
        workspaceId: attemptLease.workspaceId,
        checkpoint,
        declaration: {
          attempt_id: nearest.collection.attemptId,
          attempt_output_ref: stored,
          node_output_ref: stored,
          node_id: nearest.loopId,
        },
      });
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const result = await loadNodeAttemptInputs(harness.pool, {
        lease: attemptLease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      });
      const elapsedMs = performance.now() - started;
      const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      expect(result.structuredCollection).toMatchObject({
        loopNodeId: nearest.loopId,
        ordinal: 0,
        collectionSize: 1,
      });
      const work = harness.measurements();
      expect(work).toEqual({
        applicationQueries: 2,
        clientsAcquired: 1,
        releases: 1,
      });
      recordMeasurement({
        family: 'structured-scope-declaration-lookup',
        contractVersion: 'persisted-workflow-checkpoint-v2/workflow-graph-v1',
        population,
        upperSupportedPopulation: structuredScopeUpperSupportedPopulation,
        completedOperations: result.structuredCollection === undefined ? 0 : 1,
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
});
