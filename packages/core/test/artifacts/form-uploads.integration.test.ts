import { afterAll, beforeAll } from 'vitest';
import {
  afterAllFixture2,
  beforeAllFixture1,
} from '../triggers/forms/admission/fixture.js';
import { openUploads, uploads } from './form-uploads/fixture.js';
import { registerBindsPublicUploadsToResponse } from './form-uploads/binds-public-uploads-to-response.cases.js';
import { registerLimitsUploads } from './form-uploads/limits-uploads.cases.js';
import { registerBindsMemberAndTaskUploads } from './form-uploads/binds-member-and-task-uploads.cases.js';
import { registerKeepsPublicRespondersOut } from './form-uploads/keeps-public-responders-out.cases.js';

beforeAll(() => {
  beforeAllFixture1();
  openUploads();
});
afterAll(async () => {
  await Promise.all([afterAllFixture2(), uploads.close()]);
});
registerBindsPublicUploadsToResponse();
registerLimitsUploads();
registerBindsMemberAndTaskUploads();
registerKeepsPublicRespondersOut();
