import type { WebhookTriggerStore } from '@pertexo/core/testing';

import { vi } from 'vitest';

import type { AcceptInput } from './webhook-ingress.types.js';

export const acceptedInputs = (
  database: Pick<WebhookTriggerStore, 'acceptVerifiedDelivery'>,
): AcceptInput[] =>
  vi.mocked(database.acceptVerifiedDelivery).mock.calls.map(([input]) => input);
