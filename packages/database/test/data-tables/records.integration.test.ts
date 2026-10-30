import { beforeAll, afterAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './records/fixture.js';
import { registerStoresTypedRowsFiltersSorts } from './records/stores-typed-rows-filters-sorts.cases.js';
import { registerKeepsImportsAtomicPreventsEmpty } from './records/keeps-imports-atomic-prevents-empty.cases.js';
import { registerEnforcesWorkspaceByteQuota } from './records/enforces-workspace-byte-quota.cases.js';
import { registerImports100000RealRows } from './records/imports100000-real-rows.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerStoresTypedRowsFiltersSorts();
registerKeepsImportsAtomicPreventsEmpty();
registerEnforcesWorkspaceByteQuota();
registerImports100000RealRows();
