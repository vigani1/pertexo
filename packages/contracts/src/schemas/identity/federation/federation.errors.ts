/** SAML service-provider URLs need the app served over HTTPS. */
export class SamlHttpsOriginRequiredError extends Error {
  public override readonly name = 'SamlHttpsOriginRequiredError';
  public constructor() {
    super('SAML requires an HTTPS public app address');
  }
}
