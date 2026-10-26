import { afterAll, beforeAll } from 'vitest';
import {
  closeAuthenticatedArtifactTransferHTTPFixture,
  integrationDescribe,
  prepareAuthenticatedArtifactTransferHTTPFixture,
} from './transfer/fixture.js';
import { registerFormUploadHttpCases } from './form-uploads/http.cases.js';

integrationDescribe('form uploads over HTTP and object storage', () => {
  beforeAll(prepareAuthenticatedArtifactTransferHTTPFixture);
  afterAll(closeAuthenticatedArtifactTransferHTTPFixture);
  registerFormUploadHttpCases();
});
