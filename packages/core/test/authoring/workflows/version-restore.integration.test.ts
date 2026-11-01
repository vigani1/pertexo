import { describe } from 'vitest';

import { registerCopiesExactRetainedGraphAdvances } from './version-restore/copies-exact-retained-graph-advances.cases.js';
import { registerAppliesExistingPlaceabilityRuleRetained } from './version-restore/applies-existing-placeability-rule-retained.cases.js';
import { registerRestoresFreshTagIdenticalGraph } from './version-restore/restores-fresh-tag-identical-graph.cases.js';
describe('workflow version restoration persistence', () => {
  registerCopiesExactRetainedGraphAdvances();

  registerAppliesExistingPlaceabilityRuleRetained();

  registerRestoresFreshTagIdenticalGraph();
});
