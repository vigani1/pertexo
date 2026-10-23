import { describe } from 'vitest';

import { registerRequiresFullCurrentRepresentationTag } from './drafts/requires-full-current-representation-tag.cases.js';
import { registerAtomicallyCreatesWorkflowExactlyOne } from './drafts/atomically-creates-workflow-exactly-one.cases.js';
import { registerRejectsAbsentContextCrossTenant } from './drafts/rejects-absent-context-cross-tenant.cases.js';
describe('workflow draft persistence', () => {
  registerRequiresFullCurrentRepresentationTag();

  registerAtomicallyCreatesWorkflowExactlyOne();

  registerRejectsAbsentContextCrossTenant();
});
