import { describe } from 'vitest';

import { registerKeepsIdentityClientSchemasMechanicallyAligned } from './contracts/keeps-identity-client-schemas-mechanically-aligned.cases.js';
import { registerDocumentsAllPublicRouteTemplatesRequest } from './contracts/documents-all-public-route-templates-request.cases.js';
describe('identity/workspace generated contracts', () => {
  registerKeepsIdentityClientSchemasMechanicallyAligned();

  registerDocumentsAllPublicRouteTemplatesRequest();
});
