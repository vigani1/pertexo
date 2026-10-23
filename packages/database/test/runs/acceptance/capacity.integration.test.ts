import { describe } from 'vitest';

import { installExecutionAcceptanceFixture } from './fixtures.js';
import { registerAtomicallyAdmitsExactlyOneHundred } from './capacity/atomically-admits-exactly-one-hundred.cases.js';
import { registerResolvesExactReplayBeforeLater } from './capacity/resolves-exact-replay-before-later.cases.js';
installExecutionAcceptanceFixture();
describe('workflow run capacity admission', () => {
  registerAtomicallyAdmitsExactlyOneHundred();

  registerResolvesExactReplayBeforeLater();
});
