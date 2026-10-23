import { describe } from 'vitest';

import { installExecutionAcceptanceFixture } from './fixtures.js';
import { registerRejectsRunsSuspendedWorkspaceMalformed } from './notifications/rejects-runs-suspended-workspace-malformed.cases.js';
import { registerPinsManualRunDestinationOnce } from './notifications/pins-manual-run-destination-once.cases.js';
installExecutionAcceptanceFixture();
describe('workflow run notification pinning', () => {
  registerRejectsRunsSuspendedWorkspaceMalformed();

  registerPinsManualRunDestinationOnce();
});
