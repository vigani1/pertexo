import { afterEach } from 'vitest';

import type { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';

export const evaluators: JsonataEvaluator[] = [];
afterEach(async () => {
  await Promise.all(evaluators.splice(0).map(async (e) => e.shutdown()));
});
