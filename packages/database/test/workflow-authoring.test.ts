import { describe, expect, it } from 'vitest';

import { reconcileWorkflowTriggersPayload } from '../src/authoring/workflow-authoring.js';

describe('workflow trigger reconciliation payload', () => {
  it('emits the identifier-only trigger-reconciliation payload', () => {
    const payload = reconcileWorkflowTriggersPayload({
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      publishedVersionId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });
    expect(payload).toEqual({
      schemaVersion: 1,
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      publishedVersionId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });
    expect(() =>
      reconcileWorkflowTriggersPayload({
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        publishedVersionId: '22222222-2222-4222-8222-222222222222',
        traceparent: 'arbitrary',
        workflowId: '33333333-3333-4333-8333-333333333333',
        workspaceId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toThrow();
    expect(
      reconcileWorkflowTriggersPayload({
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        publishedVersionId: '22222222-2222-4222-8222-222222222222',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        workflowId: '33333333-3333-4333-8333-333333333333',
        workspaceId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toHaveProperty(
      'traceparent',
      '00-11111111111111111111111111111111-2222222222222222-01',
    );
  });
});
