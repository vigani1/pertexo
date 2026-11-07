import type { HttpApplicationErrorMapper } from './platform/http/index.js';
import { toProblem } from './problems/api-problem-registry.js';

export const APPLICATION_ERROR_MAPPERS: readonly HttpApplicationErrorMapper[] =
  Object.freeze([toProblem]);
