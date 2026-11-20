export const POSTGRES_FAILURE_CODES = [
  'address_blocked',
  'tls_failed',
  'connection_refused',
  'connection_failed',
  'authentication_failed',
  'timeout',
  'syntax_error',
  'constraint_violation',
  'read_only',
  'serialization',
  'query_failed',
  'row_limit',
  'result_limit',
  'invalid_columns',
  'key_not_unique',
  'canceled',
] as const;

export type PostgresFailureCode = (typeof POSTGRES_FAILURE_CODES)[number];
