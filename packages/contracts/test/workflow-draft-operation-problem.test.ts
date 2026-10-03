import { describe, expect, it } from 'vitest';
import {
  apiProblemCodeSchema,
  API_PROBLEM_MANIFEST,
} from '../src/errors/api-problem.js';

describe('native draft operation availability', () => {
  it('reports unsupported operations as an ordinary non-outage conflict', () => {
    expect(
      apiProblemCodeSchema.safeParse('workflow.draft_operation_unavailable')
        .success,
    ).toBe(true);
    expect(
      Object.entries(API_PROBLEM_MANIFEST).find(
        ([code]) => code === 'workflow.draft_operation_unavailable',
      )?.[1],
    ).toMatchObject({ status: 409 });
  });
});
