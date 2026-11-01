import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';

import { acceptPreviewRun } from '../../../src/previews/runs/acceptance.repository.js';
import { claimPreviewDelivery } from '../../../src/previews/attempts/claim.repository.js';
import type { AcceptPreviewRunInput } from '../../../src/previews/runs/acceptance/contract.js';
import type {
  PreviewAttemptLease,
  PreviewDelivery,
} from '../../../src/previews/contract.js';
import {
  canonicalOutboxPayloadChecksum,
  parseWorkspaceId,
  withTenantScopedClient,
} from '@pertexo/database/primitives';

import { databaseSchema } from '@pertexo/database/schema';

import {
  workspaceId,
  actorUserId,
  workflowId,
  apiPool,
  workerPool,
} from './base.js';

let fixtureSequence = 0;

function acceptanceInput(
  overrides: Partial<AcceptPreviewRunInput> = {},
): AcceptPreviewRunInput {
  fixtureSequence += 1;
  const now = Date.now();
  const expiresAt = overrides.expiresAt ?? new Date(now + 60 * 60 * 1_000);
  const executionDeadlineAt =
    overrides.executionDeadlineAt ??
    new Date(Math.min(now + 5 * 60 * 1_000, expiresAt.getTime()));
  return {
    actorUserId,
    definitionKey: 'http.request',
    definitionVersion: 1,
    draftFingerprint: 'b'.repeat(64),
    draftRevision: 3,
    dryRun: 'not_supported',
    executableNode: { id: 'node-1', type: 'http.request' },
    executorKey: 'http.request',
    executorVersion: 2,
    executionDeadlineAt,
    expiresAt,
    input: { kind: 'manual' as const, value: { hello: 'world' } },
    keyHash: createHash('sha256')
      .update(`preview-key-${String(fixtureSequence)}`)
      .digest('hex'),
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'node-1',
    operation: 'preview.execute',
    operationKey: 'request',
    providerKey: 'http',
    requestId: 'preview-request-id',
    requestHash: createHash('sha256')
      .update(`preview-request-${String(fixtureSequence)}`)
      .digest('hex'),
    scope: `workflow:${workflowId}:node-1`,
    sideEffectClass: 'unsafe',
    traceparent: '00-' + 'e'.repeat(32) + '-' + 'f'.repeat(16) + '-01',
    traceId: 'preview-trace-id',
    workflowId,
    ...overrides,
  };
}

export type AcceptedFixture = Omit<
  Awaited<ReturnType<typeof acceptPreviewRun>>,
  'outboxEventId' | 'previewAttemptId'
> & {
  outboxEventId: string;
  previewAttemptId: string;
  delivery: PreviewDelivery;
};

export async function acceptFixture(
  overrides: Partial<AcceptPreviewRunInput> = {},
): Promise<AcceptedFixture> {
  const input = acceptanceInput(overrides);
  const accepted = await withTenantScopedClient(
    apiPool,
    { workspaceId },
    (client) =>
      acceptPreviewRun(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        input,
      ),
  );
  if (accepted.outboxEventId === null || accepted.previewAttemptId === null)
    throw new Error('Worker fixture requires a dispatched preview');
  // The transport payload mirrors acceptance exactly, including optional
  // trace context; the checksum must cover those same bytes.
  const payload = {
    workspaceId,
    outboxEventId: accepted.outboxEventId,
    previewRunId: accepted.previewRunId,
    previewAttemptId: accepted.previewAttemptId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  } as const;
  return Object.freeze({
    ...accepted,
    outboxEventId: accepted.outboxEventId,
    previewAttemptId: accepted.previewAttemptId,
    delivery: {
      outboxEventId: accepted.outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    },
  });
}

export interface ClaimedFixture {
  kind: 'claimed';
  fixture: AcceptedFixture;
  lease: PreviewAttemptLease;
  workerId: string;
}

export async function claimFixture(
  fixture: AcceptedFixture,
  workerId: string,
  leaseDurationSeconds = 30,
): Promise<ClaimedFixture> {
  const claimed = await claimPreviewDelivery(workerPool, {
    delivery: fixture.delivery,
    leaseDurationSeconds,
    previewAttemptId: fixture.previewAttemptId,
    previewRunId: fixture.previewRunId,
    workerId,
    workspaceId,
  });
  if (claimed.kind !== 'claimed') throw new Error('expected a live claim');
  return {
    kind: 'claimed',
    fixture,
    lease: claimed.lease,
    workerId,
  };
}
