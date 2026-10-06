import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { parsePersistedWorkflowCheckpointV3 } from '../src/compatibility/persisted-workflow-checkpoint-v3.js';
import { loadCoordinatorCallMaterials } from '../src/execution/coordinator/coordinator-call-materials.js';
import type { CoordinatorEventRow } from '../src/execution/coordinator/coordinator-run-store-fact-physical-state.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const consumer = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 0,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
const checkpoint = parsePersistedWorkflowCheckpointV3({
  schemaVersion: 3,
  engineVersion: 'engine-v3',
  workflowVersionId: id(3),
  revision: 0,
  runStatus: 'running',
  nextEventSequence: 1,
  readySet: [],
  admittedInvocationKeys: [],
  invocations: [],
  joins: [],
  loops: [],
  remainingIterationBudget: 1000,
  cancelRequested: false,
  deadlineExpired: false,
  calls: [],
  branchSelections: [],
});
const event = (nodeId = 'call', key = 'call'): CoordinatorEventRow => ({
  sequence: 1,
  type: 'node.succeeded',
  payload: {},
  created_at: new Date(),
  attempt_id: id(5),
  attempt_number: 1,
  attempt_status: 'succeeded',
  attempt_output_ref: null,
  executor_failure_kind: null,
  node_output_ref: null,
  invocation_key: key,
  node_run_id: id(6),
  node_id: nodeId,
  current_attempt_id: id(5),
  node_status: 'succeeded',
  resume_at: null,
  retry_due_at: null,
  retry_decision: null,
  wait_kind: null,
});
const serializedValue = '{"number":1e-7}';
const declaration = {
  invocation_key: 'call',
  node_id: 'call',
  attempt_id: id(5),
  callee_version_id: id(7),
  snapshot: {
    reference: { schemaVersion: 1, kind: 'inline', value: { number: 1e-7 } },
    sha256: createHash('sha256').update(serializedValue).digest('hex'),
    byteLength: Buffer.byteLength(serializedValue),
    serializedValue,
  },
};
function adapter(rows: readonly unknown[] = [declaration]) {
  const query = vi.fn((sql: string) =>
    Promise.resolve({
      rows: sql.includes('read_workflow_call_declaration_materials')
        ? rows
        : [],
    }),
  );
  const client = { query } as unknown as PoolClient;
  return { query, client };
}
const request = (events: readonly CoordinatorEventRow[]) => ({
  workspaceId: id(1),
  runId: id(2),
  checkpoint,
  events,
  consumer,
  callNodeIds: new Set(['call']),
});

describe('actual coordinator Call material adapter', () => {
  it('projects accepted artifact identity without decoding or substituting payloads', async () => {
    const snapshot = {
      reference: { schemaVersion: 1, kind: 'artifact', artifactId: id(9) },
      sha256: 'b'.repeat(64),
      byteLength: 300_000,
    };
    const { client } = adapter([{ ...declaration, snapshot }]);
    const result = await loadCoordinatorCallMaterials(
      client,
      request([event()]),
    );
    expect(result?.declarations[0]).toEqual({
      invocationKey: 'call',
      nodeId: 'call',
      declarationAttemptId: id(5),
      calleeVersionId: id(7),
      input: { kind: 'artifact', artifactId: id(9) },
      inputChecksum: snapshot.sha256,
      value: undefined,
      artifactSource: {
        invocationKey: 'call',
        nodeId: 'call',
        declarationAttemptId: id(5),
        calleeVersionId: id(7),
        snapshot,
      },
    });
  });
  it('selects only immutable Call sites and forwards the exact current consumer', async () => {
    const { client, query } = adapter();
    const result = await loadCoordinatorCallMaterials(
      client,
      request([
        event(),
        ...Array.from({ length: 100 }, (_, n) =>
          event('set', `set-${String(n)}`),
        ),
      ]),
    );
    expect(query.mock.calls[0]?.[0]).toContain('$3::jsonb');
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), [
      id(2),
      ['call'],
      JSON.stringify(consumer),
    ]);
    expect(result?.declarations[0]?.value).toEqual({ number: 1e-7 });
    expect(result?.declarations[0]?.declarationAttemptId).toBe(id(5));
  });

  it('does not read declaration bytes when actual controls stop declaration work', async () => {
    const { client, query } = adapter();
    const result = await loadCoordinatorCallMaterials(client, {
      ...request([event()]),
      loadDeclarations: false,
    });
    expect(result?.declarations).toEqual([]);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('read_workflow_call_facts'),
      [id(2)],
    );
  });

  it.each([
    { rows: [] },
    { rows: [declaration, declaration] },
    { rows: [{ ...declaration, invocation_key: 'other' }] },
    { rows: [{ ...declaration, node_id: 'set' }] },
    { rows: [{ ...declaration, attempt_id: id(8) }] },
  ])(
    'refuses missing, duplicate or misbound protected projections',
    async ({ rows }) => {
      const { client, query } = adapter(rows);
      await expect(
        loadCoordinatorCallMaterials(client, request([event()])),
      ).rejects.toThrow('Persisted coordinator run state is invalid');
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses missing native consumer context before querying', async () => {
    const { client, query } = adapter();
    const { consumer: ignored, ...missing } = request([event()]);
    expect(ignored).toBe(consumer);
    await expect(
      loadCoordinatorCallMaterials(client, missing),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
