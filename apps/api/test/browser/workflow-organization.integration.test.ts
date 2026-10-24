import { describe } from 'vitest';

import { enabled } from './workflow-organization/environment.js';
import { createWorkflowOrganizationJourney } from './workflow-organization/fixture.js';
import { registerWorkflowOrganizationJourney } from './workflow-organization/journey.js';

describe.skipIf(!enabled).each(['viewer', 'builder', 'admin'] as const)(
  'owned F07 ordinary browser and real organization API — %s',
  (role) => {
    const fixture = createWorkflowOrganizationJourney({ role });
    registerWorkflowOrganizationJourney(fixture);
  },
);
