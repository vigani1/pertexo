export /**
 * ADR 045: one metadata-only row per attributed webhook attempt. Each outcome
 * fixes the HTTP status the ingress returned; the migration's check
 * constraint binds the same pairs.
 */
const HTTP_STATUS = Object.freeze({
  accepted: 202,
  coordinated: 202,
  skipped: 202,
  replayed: 202,
  authentication_failed: 401,
  invalid_request: 400,
  conflict: 409,
  rate_limited: 429,
  paused: 423,
} as const);
