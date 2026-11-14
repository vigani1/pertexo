export type AuthoringValidationUnavailableReason =
  | 'closed'
  | 'canceled'
  | 'overloaded'
  | 'payload_limit'
  | 'queue_timeout'
  | 'startup_timeout'
  | 'parse_timeout'
  | 'worker_failed'
  | 'invalid_response'
  | 'termination_failed'
  | 'report_limit'
  | 'invalid_policy_projection'
  | 'not_configured'
  | 'database_budget';
/** Never retains a graph, AST, original exception, or expression text. */
export class AuthoringValidationUnavailableError extends Error {
  constructor(readonly reason: AuthoringValidationUnavailableReason) {
    super('Workflow validation is temporarily unavailable.');
    this.name = 'AuthoringValidationUnavailableError';
  }
}
