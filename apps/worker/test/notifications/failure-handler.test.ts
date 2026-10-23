import { describe } from 'vitest';

import { registerDeliversLoadedImmutableContextPersistsBounded } from './failure-handler/delivers-loaded-immutable-context-persists-bounded.cases.js';
import { registerDoesNotWriteCompletionQueueCancellation } from './failure-handler/does-not-write-completion-queue-cancellation.cases.js';
import { registerSettlesQueueCancellationDuringIgnoredCompletion } from './failure-handler/settles-queue-cancellation-during-ignored-completion.cases.js';
describe('failure notification handler', () => {
  registerDeliversLoadedImmutableContextPersistsBounded();

  registerDoesNotWriteCompletionQueueCancellation();

  registerSettlesQueueCancellationDuringIgnoredCompletion();
});
