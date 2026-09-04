import type {
  PublishedWorkflowReader,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/testing';
import {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
} from '@pertexo/database/testing';
import { JOB_NAME, type QueueHandlerContext } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createTriggerReconciliationHandler } from '../src/triggers/trigger-handler.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const OUTBOX_EVENT_ID = '44444444-4444-4444-8444-444444444444';

const context: QueueHandlerContext = {
  signal: new AbortController().signal,
};

function delivery() {
  return {
    name: JOB_NAME.reconcileWorkflowTriggers,
    data: {
      schemaVersion: 1 as const,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      publishedVersionId: VERSION_ID,
      outboxEventId: OUTBOX_EVENT_ID,
    },
    transport: {
      attemptsMade: 0,
      jobId: `outbox-${OUTBOX_EVENT_ID}`,
    },
  } as const;
}

function dependencies() {
  const reader: PublishedWorkflowReader = {
    close: vi.fn().mockResolvedValue(undefined),
    readForExecution: vi.fn().mockResolvedValue({
      kind: 'v2_projection',
      workflowVersion: {
        id: VERSION_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
        executableSchemaVersion: 2,
        executableJson: {},
        compatibilityReleaseEpoch: 1,
      },
    }),
  };
  const reconciliation: WorkflowTriggerReconciliationDatabase = {
    close: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue([]),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  };
  return { reader, reconciliation };
}

describe('trigger reconciliation handler', () => {
  it('loads the immutable publication and reconciles a durably identified delivery', async () => {
    const selected = dependencies();
    const handler = createTriggerReconciliationHandler(selected);

    await expect(handler.handle(delivery(), context)).resolves.toEqual({
      kind: 'reconciled',
    });

    expect(selected.reader.readForExecution).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workflowVersionId: VERSION_ID,
      signal: context.signal,
    });
    expect(selected.reconciliation.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        publishedVersionId: VERSION_ID,
        outboxEventId: OUTBOX_EVENT_ID,
        delivery: expect.objectContaining({ outboxEventId: OUTBOX_EVENT_ID }),
      }),
    );
  });

  it('safely acknowledges a stale publication job', async () => {
    const selected = dependencies();
    vi.mocked(selected.reconciliation.reconcile).mockRejectedValue(
      new WorkflowTriggerStalePublicationError(),
    );

    await expect(
      createTriggerReconciliationHandler(selected).handle(delivery(), context),
    ).resolves.toEqual({ kind: 'stale' });
    expect(selected.reconciliation.recordFailure).not.toHaveBeenCalled();
  });

  it('maps durable identity mismatches to unrecoverable redelivery failures', async () => {
    const selected = dependencies();
    vi.mocked(selected.reconciliation.reconcile).mockRejectedValue(
      new WorkflowTriggerReconciliationMismatchError(),
    );

    await expect(
      createTriggerReconciliationHandler(selected).handle(delivery(), context),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(selected.reconciliation.recordFailure).not.toHaveBeenCalled();
  });

  it('records a bounded safe health reason and leaves transient failures retryable', async () => {
    const selected = dependencies();
    const outage = new Error(
      'postgresql://secret@internal.example:5432/private',
    );
    vi.mocked(selected.reconciliation.reconcile).mockRejectedValue(outage);

    await expect(
      createTriggerReconciliationHandler(selected).handle(delivery(), context),
    ).rejects.toBe(outage);
    expect(selected.reconciliation.recordFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      publishedVersionId: VERSION_ID,
      reason: 'trigger.reconciliation_failed',
    });
  });
});
