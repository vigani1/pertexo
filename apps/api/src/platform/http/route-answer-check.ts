import type { ApiNodeEnvironment } from '../config/api-config.js';

/**
 * How a route checks its answer: `project` keeps only the declared shape, so a
 * stray field never reaches a caller; `strict` fails on it, so tests and
 * development see the mismatch.
 */
export type RouteAnswerCheck = 'project' | 'strict';
export const ROUTE_ANSWER_CHECK = Symbol('ROUTE_ANSWER_CHECK');

/** Production projects its answers; every other environment checks them strictly. */
export function routeAnswerCheckFor(
  environment: ApiNodeEnvironment,
): RouteAnswerCheck {
  return environment === 'production' ? 'project' : 'strict';
}
