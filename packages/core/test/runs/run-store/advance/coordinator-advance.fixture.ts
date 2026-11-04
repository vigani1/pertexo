import { Client } from 'pg';
import { vi } from 'vitest';

import {
  asAdmin,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  workspaceA,
} from '../run-store.fixture.js';

export const signal = new AbortController().signal;
export const AT = '2026-08-21T00:00:00.000Z';

export type Invocation = Readonly<Record<string, unknown>>;

/** The sequence a plan for this run has to continue from. */
export async function nextSequence(runId: string): Promise<number> {
  const { rows } = await asAdmin((client) =>
    client.query<{ last: number | null }>(
      `select max(sequence)::int "last" from app.run_events where workflow_run_id=$1`,
      [runId],
    ),
  );
  return (rows[0]?.last ?? 0) + 1;
}

function admissionPlan(keys: readonly string[], firstSequence: number) {
  const invocations: Invocation[] = keys.map((invocationKey) => ({
    invocationKey,
    nodeId: invocationKey,
    status: 'ready',
    attemptNumber: 0,
  }));
  return {
    expectedRevision: 0,
    expectedNextEventSequence: firstSequence,
    consumedThroughEventSequence: firstSequence - 1,
    checkpoint: checkpoint({
      revision: 1,
      runStatus: 'running',
      nextEventSequence: firstSequence + keys.length + 1,
      readySet: keys,
      invocations,
    }),
    events: [
      { sequence: firstSequence, name: 'run.started', occurredAt: AT },
      ...keys.map((invocationKey, index) => ({
        sequence: firstSequence + index + 1,
        name: 'node.ready',
        occurredAt: AT,
        invocationKey,
        nodeId: invocationKey,
        attemptNumber: 0,
      })),
    ],
    nodeRunAdmissions: keys.map((invocationKey) => ({
      invocationKey,
      nodeId: invocationKey,
      sideEffectClass: 'safe',
    })),
    attempts: [],
  };
}

export const commit = (runId: string, plan: unknown) =>
  ownedDeliveryStore.commitAdvancePlan({
    workspaceId: workspaceA,
    runId,
    signal,
    plan,
  });

export async function runWithSteps(keys: readonly string[]): Promise<string> {
  const runId = await insertRun({});
  const first = await nextSequence(runId);
  await commit(runId, admissionPlan(keys, first));
  return runId;
}

type Settled = Readonly<{
  key: string;
  name: string;
  reasonCode?: string;
}>;

export async function settlePlan(runId: string, settled: readonly Settled[]) {
  const first = await nextSequence(runId);
  return {
    expectedRevision: 1,
    expectedNextEventSequence: first,
    consumedThroughEventSequence: first - 1,
    checkpoint: checkpoint({
      revision: 2,
      runStatus: 'running',
      nextEventSequence: first + settled.length,
      invocations: [...new Set(settled.map(({ key }) => key))].map(
        (invocationKey) => {
          const event = settled.find(({ key }) => key === invocationKey);
          return {
            invocationKey,
            nodeId: invocationKey,
            status: (event?.name ?? 'node.failed').slice('node.'.length),
            attemptNumber: 0,
          };
        },
      ),
    }),
    events: settled.map(({ key, name, reasonCode }, index) => ({
      sequence: first + index,
      name,
      occurredAt: AT,
      invocationKey: key,
      nodeId: key,
      attemptNumber: 0,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    })),
    nodeRunAdmissions: [],
    attempts: [],
  };
}

export const stepRows = async (runId: string) => {
  const { rows } = await asAdmin((client) =>
    client.query<{
      invocation_key: string;
      status: string;
      safe_error_code: string | null;
      completed: boolean;
    }>(
      `select invocation_key,status,safe_error_code,completed_at is not null completed
         from app.node_runs where workflow_run_id=$1`,
      [runId],
    ),
  );
  return new Map(rows.map((row) => [row.invocation_key, row]));
};

/** Every statement this process sends PostgreSQL while `work` runs. */
export async function statementsDuring(
  work: () => Promise<unknown>,
): Promise<readonly string[]> {
  const statements: string[] = [];
  type Query = (this: Client, ...values: unknown[]) => unknown;
  const prototype = Client.prototype as unknown as { query: Query };
  const { query } = prototype;
  const spy = vi.spyOn(prototype, 'query').mockImplementation(function (
    this: Client,
    ...values: unknown[]
  ) {
    const first = values[0];
    statements.push(
      typeof first === 'string'
        ? first
        : ((first as { text?: string }).text ?? ''),
    );
    return query.apply(this, values);
  });
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

export const keysFor = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);
