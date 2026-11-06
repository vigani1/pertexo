import { describe } from 'vitest';

import { workerTransportIntegrationEnabled } from '../../../support/previews/consumer.js';

export const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;
