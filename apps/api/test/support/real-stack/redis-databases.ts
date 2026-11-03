/**
 * One partition for API process stacks: fixed suites use 1–4 and security
 * leases use 5–9. Worker and browser helpers reserve 10–15; DB0 coordinates
 * security leases and must never be flushed by these stacks.
 */
export const SUITE_REDIS_DATABASES = {
  capacity: 1,
  'timed-waits': 2,
  'webhook-endpoints': 3,
  'failure-alerts': 4,
} as const;

export const SECURITY_REDIS_DATABASES = [5, 6, 7, 8, 9] as const;
