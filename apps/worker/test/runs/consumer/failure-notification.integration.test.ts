import { afterAll, beforeAll, it } from 'vitest';
import {
  restoreServicesAndClose,
  setup,
  describeIntegration,
} from './failure-notification/fixture.js';
import { seedFailureNotificationProof } from './failure-notification/execution/seed.js';
import { qualifyNotificationFences } from './failure-notification/execution/fences.js';
import { qualifyRecoveredNotificationDelivery } from './failure-notification/execution/delivery.js';

describeIntegration('Failure notification transport resilience', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);
  it('recovers failure notification dispatch through PostgreSQL and BullMQ without changing run truth', async () => {
    const scenario = await seedFailureNotificationProof();
    await qualifyNotificationFences(scenario);
    await qualifyRecoveredNotificationDelivery(scenario);
  }, 120_000);
});
