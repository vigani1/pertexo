import { afterAll, beforeAll } from 'vitest';

import { afterAllFixture2, beforeAllFixture1 } from './records/fixture.js';
import { registerAccess } from './rules/access.cases.js';
import { registerFilteredWrites } from './rules/filtered-writes.cases.js';
import { registerKeyColumn } from './rules/key-column.cases.js';
import { registerQuotas } from './rules/quotas.cases.js';
import { registerRetries } from './rules/retries.cases.js';
import { registerStates } from './rules/states.cases.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerFilteredWrites();
registerRetries();
registerAccess();
registerStates();
registerQuotas();
registerKeyColumn();
