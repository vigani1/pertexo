import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './workspace-purge/fixture.js';
import { registerRemovesDirectoryManagedGrantsOther } from './workspace-purge/removes-directory-managed-grants-other.cases.js';
import { registerPurgesEveryWorkspaceTableKeeps } from './workspace-purge/purges-every-workspace-table-keeps.cases.js';
import { registerNamesEveryWorkspaceTablePurged } from './workspace-purge/names-every-workspace-table-purged.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('workspace purge', () => {
  registerRemovesDirectoryManagedGrantsOther();

  registerPurgesEveryWorkspaceTableKeeps();

  registerNamesEveryWorkspaceTablePurged();
});
