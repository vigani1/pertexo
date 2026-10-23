import { describeIntegration } from './validate/fixture.js';
import { registerPersistsMismatchMatchingResultsSurvivesExact } from './validate/persists-mismatch-matching-results-survives-exact.cases.js';
import { registerExecutesPublishedValidateNodeThroughCoordinator } from './validate/executes-published-validate-node-through-coordinator.cases.js';
describeIntegration('core.validate persisted preview execution', () => {
  registerPersistsMismatchMatchingResultsSurvivesExact();
});
describeIntegration('core.validate persisted workflow execution', () => {
  registerExecutesPublishedValidateNodeThroughCoordinator();
});
