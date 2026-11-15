export class ConnectionNotFoundError extends Error {
  public override readonly name = 'ConnectionNotFoundError';
}

export class ConnectionConflictError extends Error {
  public override readonly name = 'ConnectionConflictError';
}

/** A stored share list is longer than the write path can ever make it. */
export class ConnectionSharingCorruptError extends Error {
  public override readonly name = 'ConnectionSharingCorruptError';
  public constructor() {
    super('Connection shares exceed the supported bound');
  }
}

export class ConnectionIdempotencyConflictError extends Error {
  public override readonly name = 'ConnectionIdempotencyConflictError';
}

export class ConnectionUnavailableError extends Error {
  public override readonly name = 'ConnectionUnavailableError';
  public constructor(
    message?: string,
    public readonly reason:
      | 'revoked'
      | 'authentication_type'
      | 'settings_changed'
      | 'unavailable' = 'revoked',
  ) {
    super(message);
  }
}

/** An OAuth2 connection with no usable grant: it says so rather than just being unavailable. */
export class ConnectionOAuth2NotConnectedError extends ConnectionUnavailableError {}

/** Revoked for good: it can't be reconnected, so a step needs another connection. */
export class ConnectionOAuth2RevokedError extends ConnectionUnavailableError {}

export class ConnectionSharingRevisionConflictError extends Error {
  override readonly name = 'ConnectionSharingRevisionConflictError';
  constructor() {
    super('Connection sharing changed');
  }
}

export class ConnectionSecretVersionConflictError extends Error {
  public override readonly name = 'ConnectionSecretVersionConflictError';
}

/** OAuth2 consent was asked of a connection that doesn't use it. */
export class ConnectionNotOAuth2Error extends Error {
  public override readonly name = 'ConnectionNotOAuth2Error';
}

export class ConnectionTestInProgressError extends Error {
  public override readonly name = 'ConnectionTestInProgressError';
}
