import { expect, it } from 'vitest';
import {
  API_PROBLEM_MANIFEST,
  apiProblemCodeSchema,
} from '../../src/errors/api-problem.js';

it('keeps the per-response upload cap a 429 problem', () => {
  expect(API_PROBLEM_MANIFEST['form.upload_limit'].status).toBe(429);
});

// web-app-13: a busy public upload allowance has its own temporary code.
it('names a busy public upload allowance with its own 429 problem', () => {
  const code = apiProblemCodeSchema.parse('form.upload_busy');
  expect(API_PROBLEM_MANIFEST[code]).toMatchObject({
    status: 429,
    exposeDetail: true,
  });
});
