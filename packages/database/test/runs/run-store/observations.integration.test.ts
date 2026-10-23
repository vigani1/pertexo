import { describe } from 'vitest';

import { registerRejectsPersistedInvalidExecutableControl } from './observations/rejects-persisted-invalid-executable-control.cases.js';
import { registerMapsOrderedStartedTerminalFacts } from './observations/maps-ordered-started-terminal-facts.cases.js';
import { registerFailsClosedEventGapsCorrupt } from './observations/fails-closed-event-gaps-corrupt.cases.js';
import { registerChunkLoadsApplicationValidFacts } from './observations/chunk-loads-application-valid-facts.cases.js';
import { registerFailsClosedStartedTerminalPhysical } from './observations/fails-closed-started-terminal-physical.cases.js';
import { registerFailsClosedTerminalArtifactLocator } from './observations/fails-closed-terminal-artifact-locator.cases.js';
describe('Coordinator observation integrity invariants', () => {
  registerRejectsPersistedInvalidExecutableControl();

  registerMapsOrderedStartedTerminalFacts();

  registerFailsClosedEventGapsCorrupt();

  registerChunkLoadsApplicationValidFacts();

  registerFailsClosedStartedTerminalPhysical();

  registerFailsClosedTerminalArtifactLocator();
});
