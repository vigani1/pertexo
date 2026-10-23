import { describe } from 'vitest';

import { registerAtomicallyPersistsReloadsScopedEach } from './foreach/atomically-persists-reloads-scoped-each.cases.js';
import { registerLoadsBodyInputsLoopDeclaration } from './foreach/loads-body-inputs-loop-declaration.cases.js';
describe('Coordinator For Each persistence invariants', () => {
  registerAtomicallyPersistsReloadsScopedEach();

  registerLoadsBodyInputsLoopDeclaration();
});
