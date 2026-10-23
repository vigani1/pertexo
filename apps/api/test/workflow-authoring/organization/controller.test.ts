import 'reflect-metadata';

import { afterEach, describe } from 'vitest';

import { cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture } from './controller/fixture.js';
import { registerRegistersMethodPathGuardsRateClass } from './controller/registers-method-path-guards-rate-class.cases.js';
import { registerRejectsPrivatePersistenceResponseExtensionsWithout } from './controller/rejects-private-persistence-response-extensions-without.cases.js';
afterEach(cleanAppsApiTestWorkflowAuthoringOrganizationControllerTestTsFixture);
describe('organization controller registered HTTP seam (fake session and persistence)', () => {
  registerRegistersMethodPathGuardsRateClass();

  registerRejectsPrivatePersistenceResponseExtensionsWithout();
});
