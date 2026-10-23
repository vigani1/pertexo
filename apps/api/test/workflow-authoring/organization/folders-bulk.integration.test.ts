import { describe } from 'vitest';

import { createFoldersBulkFixture } from './folders-bulk/fixture.js';
import { registerServesRealFolderCRUDSharedPlacementRevisions } from './folders-bulk/folder-placement.cases.js';
import { registerCommitsOrderedPartialBulkOutcomesBindsChanged } from './folders-bulk/bulk-outcomes.cases.js';
import { registerRechecksRealBuilderAuthorityOnArchivedPlacement } from './folders-bulk/role-replay.cases.js';
describe.skipIf(process.env.F07_ORGANIZATION_OWNED_FIXTURE !== 'true')(
  'owned real session folders and bulk HTTP',
  () => {
    const caseFixture = createFoldersBulkFixture();
    registerServesRealFolderCRUDSharedPlacementRevisions(caseFixture);
    registerCommitsOrderedPartialBulkOutcomesBindsChanged(caseFixture);
    registerRechecksRealBuilderAuthorityOnArchivedPlacement(caseFixture);
  },
);
