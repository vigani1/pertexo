import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { createOperatorRunReplayStore } from '../../../src/operator/replay/repository.js';

const mocks = vi.hoisted(() => ({
  acceptWorkflowRun: vi.fn(),
  close: vi.fn(),
  consumeInboxMessage: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
}));

vi.mock('../../../../database/dist/database.js', () => ({
  createWorkspaceDatabase: mocks.createWorkspaceDatabase,
}));

vi.mock('../../../src/outbox/receipts.repository.js', () => ({
  consumeInboxMessage: mocks.consumeInboxMessage,
}));

vi.mock('../../../src/runs/commands/acceptance.repository.js', () => ({
  acceptWorkflowRun: mocks.acceptWorkflowRun,
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

export const publishedVersion = {
  id: workflowVersionId,
  workspaceId,
  workflowId,
  versionNumber: 1,
  checksum: `wf:sha256:${'2'.repeat(64)}`,
  executableJson: { deliberately: 'shallow projection only' },
};

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
    { rows: [publishedVersion] },
    // The request, then its command, settle.
    { rows: [{ commandId }] },
    { rows: [{ commandId }] },
  ];
}

export function storeWith(results = validResults()) {
  const query = vi.fn<() => Promise<Record<string, unknown>[]>>();
  for (const result of results) query.mockResolvedValueOnce(result.rows);
  const where = () => {
    const result = query();
    return Object.assign(result, { limit: () => result });
  };
  const db = {
    select: () => ({
      from: () => ({ where, leftJoin: () => ({ where }) }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: query }) }) }),
  };
  const transaction = { db, workspaceId };
  const database = {
    checkReadiness: vi.fn(),
    applyInstanceCapacity: vi.fn(),
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
    applyInstanceCapacity: vi.fn(),
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
  mocks.acceptWorkflowRun.mockResolvedValue({ runId: randomUUID() });
}

export function beforeEachFixture2() {
  vi.clearAllMocks();
  mocks.close.mockResolvedValue(undefined);
}

export { mocks };
