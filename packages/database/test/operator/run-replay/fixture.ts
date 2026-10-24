import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.repository.js';
import { createOperatorRunReplayStore } from '../../../src/operator/run-replay.js';

const mocks = vi.hoisted(() => ({
  acceptWorkflowRun: vi.fn(),
  parsePublishedWorkflowRow: vi.fn(),
  close: vi.fn(),
  consumeInboxMessage: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
}));

vi.mock('../../../src/database.js', () => ({
  createWorkspaceDatabase: mocks.createWorkspaceDatabase,
}));

vi.mock('../../../src/outbox/receipts.repository.js', () => ({
  consumeInboxMessage: mocks.consumeInboxMessage,
}));

vi.mock('../../../src/runs/commands/acceptance.js', () => ({
  acceptWorkflowRun: mocks.acceptWorkflowRun,
}));

vi.mock('../../../src/runs/queries/execution/published.js', () => ({
  parsePublishedWorkflowRow: mocks.parsePublishedWorkflowRow,
}));

const config = {
  connectionString: 'postgresql://unused.test/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
} as const;

export const workspaceId = randomUUID();

export const commandId = randomUUID();

export const outboxEventId = randomUUID();

export const sourceRunId = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const payload = Object.freeze({
  commandId,
  outboxEventId,
  workspaceId,
});

const payloadChecksum = canonicalOutboxPayloadChecksum(payload);

export const attemptId = randomUUID();

export const evidenceCommandId = randomUUID();

const evidenceOutboxEventId = randomUUID();

export const evidencePayload = Object.freeze({
  attemptId,
  evidenceCommandId,
  outboxEventId: evidenceOutboxEventId,
  workspaceId,
});

const evidencePayloadChecksum = canonicalOutboxPayloadChecksum(evidencePayload);

export function validResults(): {
  rows: Record<string, unknown>[];
  rowCount?: number;
}[] {
  return [
    {
      rows: [
        {
          aggregate_id: commandId,
          aggregate_type: 'operator-command',
          job_name: 'replay-workflow-run',
          payload,
          payload_checksum: payloadChecksum,
        },
      ],
    },
    {
      rows: [
        {
          request_fingerprint: 'a'.repeat(64),
          run_input: { retained: true },
          source_run_id: sourceRunId,
          started_by: workflowId,
          status: 'pending',
          workflow_id: workflowId,
          workflow_version_id: workflowVersionId,
        },
      ],
    },
    { rows: [{ id: workflowVersionId }] },
    // The request, then its command, settle.
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ];
}

export function storeWith(results = validResults()) {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  const transaction = { db: { execute }, workspaceId };
  const database = {
    checkReadiness: vi.fn(),
    close: mocks.close,
    withWorkspace: vi.fn(),
  };
  mocks.createWorkspaceDatabase.mockReturnValue(database);
  mocks.consumeInboxMessage.mockImplementation(
    async (
      _database: unknown,
      _workspaceId: string,
      {
        operation,
      }: Readonly<{
        operation: (value: typeof transaction) => Promise<unknown>;
      }>,
    ) => ({ status: 'processed', value: await operation(transaction) }),
  );
  const checkpointFactory = vi.fn(() => ({
    checkpoint: {},
  }));
  return {
    checkpointFactory,
    database,
    execute,
    store: createOperatorRunReplayStore(config, checkpointFactory),
  };
}

export const replayInput = () => ({
  commandId,
  delivery: { outboxEventId, payloadChecksum },
  workspaceId,
});

export function reconciliationWith(
  outboxOverride?: Record<string, unknown> | null,
  evidence: Record<string, unknown> | null = {
    status: 'outcome_unknown',
  },
) {
  const outbox = {
    aggregate_id: attemptId,
    aggregate_type: 'node-attempt',
    job_name: 'reconcile-unknown-outcome',
    payload: evidencePayload,
    payload_checksum: evidencePayloadChecksum,
    ...(outboxOverride ?? {}),
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: outboxOverride === null ? [] : [outbox] })
    .mockResolvedValueOnce({ rows: evidence === null ? [] : [evidence] });
  const transaction = { db: { execute }, workspaceId };
  const database = {
    checkReadiness: vi.fn(),
    close: mocks.close,
    withWorkspace: vi.fn(),
  };
  mocks.consumeInboxMessage.mockImplementation(
    async (
      _database: unknown,
      _workspaceId: string,
      {
        operation,
      }: Readonly<{
        operation: (value: typeof transaction) => Promise<unknown>;
      }>,
    ) => ({ status: 'processed', value: await operation(transaction) }),
  );
  return {
    database,
    execute,
    input: {
      attemptId,
      delivery: {
        outboxEventId: evidenceOutboxEventId,
        payloadChecksum: evidencePayloadChecksum,
      },
      evidenceCommandId,
      workspaceId,
    },
  };
}

export function beforeEachFixture1() {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
  mocks.parsePublishedWorkflowRow.mockReturnValue({ workflowId });
  mocks.acceptWorkflowRun.mockResolvedValue({ runId: randomUUID() });
}

export function beforeEachFixture2() {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
}

export { mocks };
