import { reconcileWorkflowTriggersPayload } from '@pertexo/database/testing';
import { ReconcileWorkflowTriggersJobSchema } from '@pertexo/queue';
import { describe, expect, it } from 'vitest';

describe('workflow publication transport composition', () => {
  it('keeps the persisted reconciliation payload compatible with the queue contract', () => {
    const payload = reconcileWorkflowTriggersPayload({
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      publishedVersionId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });

    expect(ReconcileWorkflowTriggersJobSchema.parse(payload)).toEqual(payload);
  });
});
