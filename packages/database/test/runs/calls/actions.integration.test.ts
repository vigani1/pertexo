import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './actions/fixture.js';
import { registerDoesNotSpawnAfterOpposing } from './actions/does-not-spawn-after-opposing.cases.js';
import { registerCancelsChildThroughOwnOrdinary } from './actions/cancels-child-through-own-ordinary.cases.js';
import { registerDoesNotSpawnOrdinaryParent } from './actions/does-not-spawn-ordinary-parent.cases.js';
import { registerPassesErrorWorkflowOriginChild } from './actions/passes-error-workflow-origin-child.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('ordinary run acceptance as a durable Call action', () => {
  registerDoesNotSpawnAfterOpposing();

  registerCancelsChildThroughOwnOrdinary();

  registerDoesNotSpawnOrdinaryParent();
});
registerPassesErrorWorkflowOriginChild();
