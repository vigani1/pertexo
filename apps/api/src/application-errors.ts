import type { HttpApplicationErrorMapper } from './platform/http/index.js';
import { toProblem } from './problems/registry.js';

export const APPLICATION_ERROR_MAPPERS: readonly HttpApplicationErrorMapper[] =
  Object.freeze([toProblem]);
