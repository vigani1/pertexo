export class ApiTokenPolicyError extends Error {
  override readonly name = 'ApiTokenPolicyError';
  constructor(
    readonly reason:
      'authority_inactive' | 'scope_forbidden' | 'token_limit' | 'not_found',
  ) {
    super('API token operation is not permitted');
  }
}
