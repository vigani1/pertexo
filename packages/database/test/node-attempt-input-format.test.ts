import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type * as transactions from '../src/execution/node-attempts/node-attempt-run-store-transactions.js';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNodeAttemptInputs } from '../src/execution/node-attempts/node-attempt-run-store-inputs.js';

const { query, readTransaction } = vi.hoisted(() => ({
  query: vi.fn(),
  readTransaction: vi.fn(),
}));
vi.mock(
  '../src/execution/node-attempts/node-attempt-run-store-transactions.js',
  async (original) => ({
    ...(await original<typeof transactions>()),
    withWorkspaceReadClient: readTransaction,
  }),
);
const version = '00000000-1111-4111-8111-111111111111';
const lease: NodeAttemptLease = {
  workspaceId: version,
  runId: version,
  workflowVersionId: version,
  nodeRunId: version,
  attemptId: version,
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${version}|manual|b:|i:`,
  nodeId: 'manual',
  sideEffectClass: 'safe',
  workerId: 'worker',
  fenceToken: 1,
  leaseExpiresAt: new Date(),
  delivery: { outboxEventId: version, payloadChecksum: 'a'.repeat(64) },
};
const checkpoint = {
  schemaVersion: 3,
  engineVersion: 'engine-v3',
  workflowVersionId: version,
  revision: 0,
  runStatus: 'queued',
  nextEventSequence: 2,
  readySet: [],
  admittedInvocationKeys: [],
  invocations: [],
  joins: [],
  loops: [],
  calls: [],
  remainingIterationBudget: 1_000,
  cancelRequested: false,
  deadlineExpired: false,
  branchSelections: [],
};
const row = {
  abort_reason: null,
  abort_requested: false,
  deadline_at: null,
  input_ref: { schemaVersion: 1, kind: 'inline', value: { name: 'input' } },
  scheduler_state: checkpoint,
  graph_schema_version: 2,
  executable_schema_version: 3,
  executable_checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
};
beforeEach(() => {
  vi.clearAllMocks();
  readTransaction.mockImplementation(
    (
      _pool: Pool,
      _workspace: string,
      _signal: AbortSignal,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query } as unknown as PoolClient),
  );
  query.mockImplementation((sql: string) =>
    Promise.resolve({
      rows: sql.includes('read_native_attempt_value_source')
        ? [
            {
              source: {
                slot: 'run_input',
                source: {
                  kind: 'run_input',
                  workspaceId: version,
                  runId: version,
                  workflowVersionId: version,
                  provenanceId: version,
                },
                snapshot: {
                  reference: row.input_ref,
                  serializedValue: '{"name":"input"}',
                  sha256: createHash('sha256')
                    .update('{"name":"input"}')
                    .digest('hex'),
                  byteLength: 16,
                },
              },
            },
          ]
        : [row],
    }),
  );
});
function load() {
  return loadNodeAttemptInputs({} as Pool, {
    lease,
    upstreamNodeOutputs: [],
    signal: new AbortController().signal,
  });
}
describe('node input checkpoint format selected by actual version (mocked read owner)', () => {
  it('loads explicit Graph2/executable3/Checkpoint3 protected source input', async () => {
    await expect(load()).resolves.toMatchObject({
      runInput: null,
      completedNodeOutputs: [],
      nativeValueSources: {
        runInput: { snapshot: { reference: row.input_ref } },
      },
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      'join app.workflow_versions version',
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'version.workflow_id=run.workflow_id',
    );
  });
  it.each([
    { graph_schema_version: 1 },
    { executable_schema_version: 2 },
    { executable_schema_version: null },
    { executable_checksum: `wf:v2:sha256:${'a'.repeat(64)}` },
    {
      graph_schema_version: 1,
      executable_schema_version: 2,
      executable_checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
    },
    { scheduler_state: { ...checkpoint, schemaVersion: 2 } },
    {
      scheduler_state: {
        ...checkpoint,
        workflowVersionId: '99999999-1111-4111-8111-111111111111',
      },
    },
  ])(
    'rejects mismatched outer/checkpoint format without fallback %#',
    async (patch) => {
      query.mockResolvedValue({ rows: [{ ...row, ...patch }] });
      await expect(load()).rejects.toBeDefined();
    },
  );
  it('preserves the retained Graph1/executable2/Checkpoint2 path', async () => {
    const { calls: _calls, ...ordinary } = checkpoint;
    query.mockResolvedValue({
      rows: [
        {
          ...row,
          graph_schema_version: 1,
          executable_schema_version: 2,
          executable_checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
          scheduler_state: { ...ordinary, schemaVersion: 2 },
        },
      ],
    });
    await expect(load()).resolves.toMatchObject({
      runInput: { name: 'input' },
    });
  });
});
