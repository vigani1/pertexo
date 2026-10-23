import { describe } from 'vitest';

import { registerReplaysCompletedCommandBeforeCatalog } from './duplication/replays-completed-command-before-catalog.cases.js';
import { registerCreatesExactlyOneUnpublishedRevision } from './duplication/creates-exactly-one-unpublished-revision.cases.js';
import { registerRollsBackEntireCommandAfter } from './duplication/rolls-back-entire-command-after.cases.js';
import { registerRetainsSameWorkspaceConnectionReferences } from './duplication/retains-same-workspace-connection-references.cases.js';
import { registerReapsExpiredSourceScopedDuplication } from './duplication/reaps-expired-source-scoped-duplication.cases.js';
describe('same-workspace workflow duplication through the runtime database role', () => {
  registerReplaysCompletedCommandBeforeCatalog();

  registerCreatesExactlyOneUnpublishedRevision();

  registerRollsBackEntireCommandAfter();

  registerRetainsSameWorkspaceConnectionReferences();

  registerReapsExpiredSourceScopedDuplication();
});
