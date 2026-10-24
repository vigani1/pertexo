import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../../src/outbox/events.repository.js';
import { createOperatorRunReplayStore } from '../../../src/operator/replay/repository.js';

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
          aggregateId: commandId,
          aggregateType: 'operator-command',
          jobName: 'replay-workflow-run',
          payload,
          payloadChecksum: payloadChecksum,
        },
      ],
    },
    {
      rows: [
        {
          requestFingerprint: 'a'.repeat(64),
          runInput: { retained: true },
          sourceRunId: sourceRunId,
          startedBy: workflowId,
          status: 'pending',
          workflowId: workflowId,
          workflowVersionId: workflowVersionId,
        },
      ],
    },
    { rows: [{ id: workflowVersionId }] },
    // The request, then its command, settle.
    { rows: [{ commandId }] },
    { rows: [{ commandId }] },
  ];
}

export function storeWith(results = validResults()) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result.rows);
  const db = {
    select: () => ({
      from: () => ({ where: query, leftJoin: () => ({ where: query }) }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: query }) }) }),
  };
  const transaction = { db, workspaceId };
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
    query,
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
    aggregateId: attemptId,
    aggregateType: 'node-attempt',
    jobName: 'reconcile-unknown-outcome',
    payload: evidencePayload,
    payloadChecksum: evidencePayloadChecksum,
    ...(outboxOverride ?? {}),
  };
  const read = vi
    .fn()
    .mockResolvedValueOnce(outboxOverride === null ? [] : [outbox])
    .mockResolvedValueOnce(evidence === null ? [] : [evidence]);
  const select = vi.fn(() => ({
    from: () => ({ where: read, innerJoin: () => ({ where: read }) }),
  }));
  const transaction = { db: { select }, workspaceId };
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
    read,
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
