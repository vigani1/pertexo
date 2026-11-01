import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './columns/fixture.js';
import { registerKeepsColumnIDsThroughRename } from './columns/keeps-column-ids-through-rename.cases.js';
import { registerExportsBeyondPageOneEntire } from './columns/exports-beyond-page-one-entire.cases.js';
import { registerChecksSingletonMultipleTableBindings } from './columns/checks-singleton-multiple-table-bindings.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerKeepsColumnIDsThroughRename();
registerExportsBeyondPageOneEntire();
registerChecksSingletonMultipleTableBindings();
