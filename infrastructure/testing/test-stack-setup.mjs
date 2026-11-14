import { requireTestStack } from './test-stack.mjs';

/** Vitest global setup for a suite that uses PostgreSQL and Redis. */
export default function refuseWithoutTestStack() {
  requireTestStack();
}
