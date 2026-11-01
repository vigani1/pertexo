import type { WebhookTriggerDatabase } from '@pertexo/core/testing';

import { vi } from 'vitest';

import type { AcceptInput } from './contract.js';

export const acceptedInputs = (
  database: Pick<WebhookTriggerDatabase, 'acceptVerifiedDelivery'>,
): AcceptInput[] =>
  vi.mocked(database.acceptVerifiedDelivery).mock.calls.map(([input]) => input);
