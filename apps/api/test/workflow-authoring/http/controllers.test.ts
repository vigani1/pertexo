import { describe } from 'vitest';

import { registerPassesExactVersionFilterUnderNormal } from './controllers/passes-exact-version-filter-under-normal.cases.js';
import { registerDelegatesPinnedParentReadRejectsOrganization } from './controllers/delegates-pinned-parent-read-rejects-organization.cases.js';
import { registerDelegatesOneValidCreateCommandMaps } from './controllers/delegates-one-valid-create-command-maps.cases.js';
describe('workflow authoring controller public seam', () => {
  registerPassesExactVersionFilterUnderNormal();

  registerDelegatesPinnedParentReadRejectsOrganization();

  registerDelegatesOneValidCreateCommandMaps();
});
