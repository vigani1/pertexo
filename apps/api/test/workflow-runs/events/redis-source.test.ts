import { describe } from 'vitest';

import { registerUsesStableOpaqueWorkspaceRunSpecific } from './redis-source/uses-stable-opaque-workspace-run-specific.cases.js';
import { registerTurnsReconnectIntoDurableResyncAfter } from './redis-source/turns-reconnect-into-durable-resync-after.cases.js';
import { registerMakesRepeatedCloseIdempotentRemovesListeners } from './redis-source/makes-repeated-close-idempotent-removes-listeners.cases.js';
describe('Redis run event source', () => {
  registerUsesStableOpaqueWorkspaceRunSpecific();

  registerTurnsReconnectIntoDurableResyncAfter();

  registerMakesRepeatedCloseIdempotentRemovesListeners();
});
