import { createFailureNotificationStore } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { databaseUrl, workerUrl } from '../fixture.js';
import type { FailureNotificationScenario } from './contract.js';
import { assertPostgresLossBeforeFence } from './postgres-loss.js';
import { assertProviderFenceDrain } from './provider-fence.js';

export async function qualifyNotificationFences(
  scenario: FailureNotificationScenario,
) {
  const store = createFailureNotificationStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 2,
    }),
  );
  try {
    await assertPostgresLossBeforeFence(scenario, store);
    await assertProviderFenceDrain(scenario, store);
  } finally {
    await store.close();
  }
}
