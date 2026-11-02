import { expect, it } from 'vitest';

import { loadBuiltEntry } from '../support/built-entry.js';

it('loads @pertexo/core/triggers as a built package with what its callers use', async () => {
  const names = await loadBuiltEntry('@pertexo/core/triggers');
  expect(names).toEqual(
    expect.arrayContaining([
      'WebhookDeliveryIneligibleError',
      'WebhookIngressRateLimitExceededError',
      'WebhookIntakeBusyError',
      'WebhookWorkflowPausedError',
      'FormUnavailableError',
      'ScheduleTriggerError',
      'createFormStore',
      'createScheduleTriggerScanner',
      'createScheduleTriggerStore',
      'createWebhookTriggerStore',
    ]),
  );
  // The rule stays behind the stores, so no caller can decide closed addresses itself.
  expect(names).not.toContain('endpointTakesDeliveries');
}, 60_000);
