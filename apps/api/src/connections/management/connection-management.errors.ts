export class ConnectionResponseError extends Error {
  public override readonly name = 'ConnectionResponseError';
}

export class OAuth2ConnectionsUnavailableError extends Error {
  public override readonly name = 'OAuth2ConnectionsUnavailableError';
}
