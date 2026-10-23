import { describe } from 'vitest';

import { registerSubstitutesTestPinBeforeMappingsInput } from './engine/substitutes-test-pin-before-mappings-input.cases.js';
import { registerKeepsNestedBranchAncestryRemovesIntroducing } from './engine/keeps-nested-branch-ancestry-removes-introducing.cases.js';
describe('node attempt execution engine', () => {
  registerSubstitutesTestPinBeforeMappingsInput();

  registerKeepsNestedBranchAncestryRemovesIntroducing();
});
