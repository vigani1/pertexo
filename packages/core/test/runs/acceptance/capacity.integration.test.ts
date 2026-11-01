import { describe } from 'vitest';

import { useInstanceCapacity } from '../../support/instance-capacity.js';
import { apiUrl, installExecutionAcceptanceFixture } from './fixtures.js';
import { registerAtomicallyAdmitsExactlyOneHundred } from './capacity/atomically-admits-exactly-one-hundred.cases.js';
import { registerResolvesExactReplayBeforeLater } from './capacity/resolves-exact-replay-before-later.cases.js';
installExecutionAcceptanceFixture();
describe('workflow run capacity admission', () => {
  useInstanceCapacity(
    {
      activeRunLimit: 5,
      queuedRunLimit: 100,
      artifactCountLimit: 1_000,
    },
    apiUrl,
  );
  registerAtomicallyAdmitsExactlyOneHundred();

  registerResolvesExactReplayBeforeLater();
});
