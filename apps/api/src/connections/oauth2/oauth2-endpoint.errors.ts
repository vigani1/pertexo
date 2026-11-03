/** S15: an address this install won't use, naming the field it came from. */
export class OAuth2EndpointRefusedError extends Error {
  public override readonly name = 'OAuth2EndpointRefusedError';
  public constructor(public readonly field: 'authorizationUrl' | 'tokenUrl') {
    super(`OAuth2 ${field} refused`);
  }
}

/** A server-to-server start the service answered with no usable token. */
export class OAuth2TokenRefusedError extends Error {
  public override readonly name = 'OAuth2TokenRefusedError';
  public constructor() {
    super('The service refused the token request');
  }
}

/** A server-to-server start during an outage or a rate limit at the service. */
export class OAuth2ProviderUnavailableError extends Error {
  public override readonly name = 'OAuth2ProviderUnavailableError';
  public constructor() {
    super('The service did not answer the token request');
  }
}
