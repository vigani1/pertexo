import { describe } from 'vitest';

import { registerReplaysSafelyCommitAcknowledgementIs } from './cas/replays-safely-commit-acknowledgement-is.cases.js';
import { registerRollsBackAllWritesLate } from './cas/rolls-back-all-writes-late.cases.js';
import { registerAtomicallyPersistsBranchScopedReady } from './cas/atomically-persists-branch-scoped-ready.cases.js';
describe('Coordinator CAS and transition invariants', () => {
  registerReplaysSafelyCommitAcknowledgementIs();

  registerRollsBackAllWritesLate();

  registerAtomicallyPersistsBranchScopedReady();
});
