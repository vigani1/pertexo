import { describe, expect, it } from 'vitest';

import { endpointTakesDeliveries } from '../../../src/triggers/webhooks/runtime/endpoint-rules.js';

const open = {
  endpointStatus: 'active',
  workflowLifecycleStatus: 'active',
  workspaceStatus: 'active',
};

describe('whether an address takes deliveries', () => {
  it('takes them only when the endpoint, workflow and workspace are all active', () => {
    expect(endpointTakesDeliveries(open)).toBe(true);
  });

  it.each([
    ['endpointStatus', 'disabled'],
    ['endpointStatus', 'retired'],
    ['workflowLifecycleStatus', 'archived'],
    ['workspaceStatus', 'suspended'],
    ['workspaceStatus', 'pending_deletion'],
    ['workspaceStatus', 'purging'],
    ['workspaceStatus', 'deleted'],
  ])('refuses when %s is %s', (field, status) => {
    expect(endpointTakesDeliveries({ ...open, [field]: status })).toBe(false);
  });
});
