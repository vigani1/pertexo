import type { FederationSettings } from '@pertexo/contracts';
export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type OrganizationSnapshot = NonNullable<
  FederationSettings['organization']
>;
export type {
  OrganizationRecord as OrganizationRow,
  ProviderRecord as ProviderRow,
  DomainRecord as DomainRow,
} from './records.queries.js';
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
