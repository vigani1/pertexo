import { describe } from 'vitest';

import { installExecutionAcceptanceFixture } from '../../runs/acceptance/fixtures.js';

import { registerRechecksCapAfterCounterWait } from './concurrency-review-regressions/rechecks-cap-after-counter-wait.cases.js';
import { registerRestrictsReservationRebindAppRole } from './concurrency-review-regressions/restricts-reservation-rebind-app-role.cases.js';
installExecutionAcceptanceFixture();
describe('workflow concurrency review regressions', () => {
  registerRechecksCapAfterCounterWait();

  registerRestrictsReservationRebindAppRole();
});
