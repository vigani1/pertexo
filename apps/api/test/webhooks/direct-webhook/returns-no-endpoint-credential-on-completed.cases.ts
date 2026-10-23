import { expect, it } from 'vitest';

import { service, workspaceId, seedWebhook } from './fixture.js';

export function registerReturnsNoEndpointCredentialOnCompleted(): void {
  it('returns no endpoint credential on a completed endpoint-rotation replay', async () => {
    const { actorId, trigger, workflowId } = await seedWebhook('management');
    const endpointRotation = {
      workspaceId,
      workflowId,
      actorId,
      triggerId: trigger.id,
      idempotencyKey: 'direct-webhook-rotate-endpoint',
    };
    const rotatedEndpoint = await service.rotateEndpoint(endpointRotation);
    expect(rotatedEndpoint.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(service.rotateEndpoint(endpointRotation)).resolves.toEqual({
      trigger: rotatedEndpoint.trigger,
      replayed: true,
    });
  }, 60_000);
}
