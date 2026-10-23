import { describe } from 'vitest';

import { registerNormalizesFullParentWithoutReorderingSelection } from './use-case/normalizes-full-parent-without-reordering-selection.cases.js';
import { registerRechecksAuthorityAfterSQLNotFound } from './use-case/rechecks-authority-after-sqlnot-found.cases.js';
import { registerRejectsStrictInvalidSParentsBefore } from './use-case/rejects-strict-invalid-sparents-before.cases.js';
describe('workflow organization full-parent batch orchestration', () => {
  registerNormalizesFullParentWithoutReorderingSelection();

  registerRechecksAuthorityAfterSQLNotFound();

  registerRejectsStrictInvalidSParentsBefore();
});
