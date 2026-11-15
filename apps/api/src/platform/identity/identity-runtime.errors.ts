export class IdentityRuntimeConfigurationError extends TypeError {
  public override readonly name = 'IdentityRuntimeConfigurationError';
}

export class OrganizationKeyUnavailableError extends Error {
  public override readonly name = 'OrganizationKeyUnavailableError';
}
