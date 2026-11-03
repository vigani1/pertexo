export class FederationConflictError extends Error {
  constructor(
    public readonly reason:
      | 'owner_required'
      | 'stale'
      | 'limit'
      | 'unavailable'
      | 'domain_claimed'
      | 'dns_unverified'
      | 'recovery_required'
      | 'provider_untested',
    message: string,
  ) {
    super(message);
    this.name = 'FederationConflictError';
  }
}
