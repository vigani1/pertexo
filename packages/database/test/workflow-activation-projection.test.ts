import { describe, expect, it } from 'vitest';

import { mapWorkflow } from '../src/authoring/workflow-authoring-rows.js';

function storedWorkflow(activationStatus: unknown) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: '22222222-2222-4222-8222-222222222222',
    name: 'Trigger health',
    lifecycle_status: 'active',
    lifecycle_revision: 1,
    activation_status: activationStatus,
    published_version_id: '33333333-3333-4333-8333-333333333333',
    created_by: '44444444-4444-4444-8444-444444444444',
    created_at: new Date('2026-09-06T00:00:00.000Z'),
    updated_at: new Date('2026-09-06T01:00:00.000Z'),
  };
}

describe('workflow activation projection', () => {
  it.each([
    'inactive',
    'activating',
    'active',
    'deactivating',
    'degraded',
    'error',
  ])('preserves persisted %s health independently of lifecycle', (status) => {
    const row = storedWorkflow(status);
    expect(mapWorkflow(row)).toMatchObject({
      activationStatus: status,
      lifecycleStatus: 'active',
      publishedVersionId: row.published_version_id,
    });
    expect(mapWorkflow({ ...row, lifecycle_status: 'archived' })).toMatchObject(
      {
        activationStatus: status,
        lifecycleStatus: 'archived',
      },
    );
    expect(row.activation_status).toBe(status);
  });

  it.each(['enabled', '', null, undefined, 1])(
    'rejects unknown persisted activation %s instead of fabricating inactive',
    (status) => {
      expect(() => mapWorkflow(storedWorkflow(status))).toThrow();
    },
  );
});
