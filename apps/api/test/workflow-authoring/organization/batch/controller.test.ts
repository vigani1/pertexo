import 'reflect-metadata';

import { afterEach, describe } from 'vitest';

import { cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture } from './controller/fixture.js';
import { registerRejectsInvalidWorkspaceFolderWorkflowParams } from './controller/rejects-invalid-workspace-folder-workflow-params.cases.js';
import { registerGuardedRouteMatrix } from './controller/guarded-route-matrix.cases.js';
afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);
describe('folder and batch HTTP routes with controlled session/persistence', () => {
  registerGuardedRouteMatrix();
  registerRejectsInvalidWorkspaceFolderWorkflowParams();
});
