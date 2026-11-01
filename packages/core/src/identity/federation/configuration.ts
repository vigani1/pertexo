import type { OidcConfiguration, SamlConfiguration } from '@pertexo/contracts';
type ProviderConfiguration = Readonly<{
  kind: 'oidc' | 'saml';
  configuration: OidcConfiguration | SamlConfiguration;
}>;
// Provider writes validate the configuration for its kind before persisting it.
export function providerHasKind<
  Row extends ProviderConfiguration,
  Kind extends Row['kind'],
>(
  row: Row,
  kind: Kind,
): row is Row & {
  kind: Kind;
  configuration: Kind extends 'oidc' ? OidcConfiguration : SamlConfiguration;
} {
  return row.kind === kind;
}
