import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../../../src/lib/api/client';
import { commandWebhook } from '../../../src/features/workflow-settings/data/workflow-settings.api';

const sent = async (
  input: Parameters<typeof commandWebhook>[0]['input'],
): Promise<Record<string, unknown>> => {
  const request = vi.fn().mockResolvedValue({});
  await commandWebhook({
    apiClient: { request } as unknown as ApiClient,
    workspaceId: 'workspace',
    workflowId: 'workflow',
    triggerId: 'trigger',
    input,
  });
  return request.mock.calls[0]?.[0] as Record<string, unknown>;
};

describe('what the web app sends a webhook command', () => {
  it.each(['provision', 'rotate-endpoint'] as const)(
    'sends %s no body, because the API refuses one that names anything',
    async (command) => {
      const request = await sent({ command, idempotencyKey: 'key' });
      expect(request).not.toHaveProperty('body');
      expect(request.path).toMatch(new RegExp(`/webhook/${command}$`, 'u'));
      expect(request.headers).toEqual({ 'Idempotency-Key': 'key' });
    },
  );
});
