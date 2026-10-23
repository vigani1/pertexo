import { describe } from 'vitest';

import { registerForwardsCapacityReadsCancellationWithoutChanging } from './postgres-persistence/forwards-capacity-reads-cancellation-without-changing.cases.js';
import { registerDoesNotTurnCommittedAcceptanceCancellation } from './postgres-persistence/does-not-turn-committed-acceptance-cancellation.cases.js';
import { registerInitializesCheckpointVerifiedSwitchExecutable } from './postgres-persistence/initializes-checkpoint-verified-switch-executable.cases.js';
describe('PostgreSQL workflow run persistence adapter', () => {
  registerForwardsCapacityReadsCancellationWithoutChanging();

  registerDoesNotTurnCommittedAcceptanceCancellation();

  registerInitializesCheckpointVerifiedSwitchExecutable();
});
