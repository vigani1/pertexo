import { it } from 'vitest';

import { seedFailureNotificationProof } from './execution/seed.js';
import { qualifyNotificationFences } from './execution/fences.js';
import { qualifyRecoveredNotificationDelivery } from './execution/delivery.js';

export function registerRecoversFailureNotificationDispatchThroughPostgreSQL(): void {
  it('recovers failure notification dispatch through PostgreSQL and BullMQ without changing run truth', async () => {
    const scenario = await seedFailureNotificationProof();
    await qualifyNotificationFences(scenario);
    await qualifyRecoveredNotificationDelivery(scenario);
  }, 120_000);
}
