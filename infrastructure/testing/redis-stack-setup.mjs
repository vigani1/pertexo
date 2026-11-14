import { requireTestStack } from './test-stack.mjs';

/** Vitest global setup for a suite that uses only Redis. */
export default function refuseWithoutRedisStack() {
  requireTestStack(['REDIS_URL']);
}
