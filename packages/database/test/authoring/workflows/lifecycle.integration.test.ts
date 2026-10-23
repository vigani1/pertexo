import { describe } from 'vitest';

import { registerRejectsReplayWhoseDurableLifecycle } from './lifecycle/rejects-replay-whose-durable-lifecycle.cases.js';
import { registerSerializesPublicationLifecycleCommandsOn } from './lifecycle/serializes-publication-lifecycle-commands-on.cases.js';
describe('workflow lifecycle command persistence', () => {
  registerRejectsReplayWhoseDurableLifecycle();

  registerSerializesPublicationLifecycleCommandsOn();
});
